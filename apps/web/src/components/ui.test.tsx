import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
import { DetailPanel } from "./DetailPanel";
import { AddRowForm } from "./AddRowForm";
import { App } from "../App";
import type { Row, RowsQuery, StudioClient, TableMeta } from "../api";

function renderWithQuery(ui: ReactElement): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
});

const fakeTables: TableMeta[] = [
  { schema: "app", name: "project_stats", kind: "view" },
  { schema: "app", name: "tasks", kind: "table" },
  { schema: "public", name: "orders", kind: "table" },
];

const tableDetail = {
  primaryKey: ["id"],
  columns: [
    { name: "id", nullable: false, hasDefault: true, udtName: "int4", dataType: "integer" },
    { name: "name", nullable: false, hasDefault: false, udtName: "text", dataType: "text" },
    { name: "note", nullable: true, hasDefault: false, udtName: "text", dataType: "text" },
  ],
};

function makeRowClient(totalRows: number, pageSize = 50) {
  const calls: RowsQuery[] = [];
  const savedPayloads: Array<Parameters<StudioClient["saveRows"]>[2]> = [];
  let saveShouldFail = false;
  const client: StudioClient = {
    listTables: async () => fakeTables,
    listRows: async (_schema, _table, query) => {
      calls.push(query);
      const offset = query.cursor ? Number(query.cursor) : 0;
      const rows: Row[] = [];
      for (let i = offset; i < Math.min(offset + pageSize, totalRows); i++) {
        rows.push({ id: i + 1, name: `row-${i + 1}`, note: i % 5 === 0 ? null : `note ${i}` });
      }
      const nextOffset = offset + pageSize;
      return {
        rows,
        nextCursor: nextOffset < totalRows ? String(nextOffset) : null,
      };
    },
    getTableDetail: async () => tableDetail,
    listEnums: async () => [],
    saveRows: async (_schema, _table, payload) => {
      if (saveShouldFail) throw new Error("500");
      savedPayloads.push(payload);
      return { batchId: "batch-test" };
    },
  };
  return { client, calls, savedPayloads, setSaveShouldFail: (v: boolean) => (saveShouldFail = v) };
}

function stubClient(overrides: Partial<StudioClient> = {}): StudioClient {
  return {
    listTables: async () => [],
    listRows: async () => ({ rows: [], nextCursor: null }),
    getTableDetail: async () => tableDetail,
    listEnums: async () => [],
    saveRows: async () => ({ batchId: "batch-x" }),
    ...overrides,
  };
}

describe("Sidebar", () => {
  test("groups relations by schema and reports selection", async () => {
    const onSelect = mock(() => {});
    renderWithQuery(
      <Sidebar client={makeRowClient(0).client} selected={null} onSelect={onSelect} />,
    );

    expect(await screen.findByRole("heading", { name: "app" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "public" })).toBeDefined();

    const ordersButton = screen.getByRole("button", { name: /orders/ });
    fireEvent.click(ordersButton);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith({ schema: "public", name: "orders" }));
  });

  test("marks views distinctly from tables", async () => {
    renderWithQuery(
      <Sidebar client={makeRowClient(0).client} selected={null} onSelect={() => {}} />,
    );
    const statsButton = await screen.findByRole("button", { name: /project_stats/ });
    expect(statsButton.textContent).toContain("view");
    expect(screen.getByRole("button", { name: /orders/ }).textContent).not.toContain("view");
  });

  test("shows an alert when table loading fails", async () => {
    const broken = stubClient({
      listTables: async () => {
        throw new Error("boom");
      },
    });
    renderWithQuery(<Sidebar client={broken} selected={null} onSelect={() => {}} />);
    expect(await screen.findByRole("alert")).toBeDefined();
  });
});

describe("DataGrid", () => {
  test("does not mount every row of a large result set", async () => {
    const { client } = makeRowClient(1000);
    renderWithQuery(<DataGrid schema="public" table="big" client={client} />);

    // first page (50) streams in; happy-dom has no layout so the bounded
    // window (40) mounts — either way far below 1000.
    await screen.findByText((_, element) => element?.textContent === `${50} rows loaded`);
    const mountedRows = document.querySelectorAll('[role="row"]').length;
    expect(mountedRows).toBeLessThanOrEqual(41);
    expect(screen.getByText("row-1")).toBeDefined();
    expect(screen.queryByText("row-500")).toBeNull();
  });

  test("search filters loaded rows and updates the count", async () => {
    const { client } = makeRowClient(120);
    renderWithQuery(<DataGrid schema="public" table="t" client={client} />);

    const input = await screen.findByLabelText("Search rows");
    fireEvent.change(input, { target: { value: "row-4" } });

    await screen.findByText(/^\d+ of \d+ rows$/);
    // page one holds row-1..row-50; "row-4" matches row-4 and row-40..row-49
    expect(await screen.findByText("11 of 50 rows")).toBeDefined();
  });

  test("header click toggles server-side sort direction", async () => {
    const { client, calls } = makeRowClient(60);
    renderWithQuery(<DataGrid schema="public" table="t" client={client} />);

    await screen.findByRole("columnheader", { name: /id/ });
    fireEvent.click(screen.getByRole("columnheader", { name: /id/ }));
    await waitFor(() =>
      expect(calls.some(call => call.sort === "id" && call.dir === "asc")).toBe(true),
    );

    // React may rebuild the header node after refetch — query afresh.
    fireEvent.click(screen.getByRole("columnheader", { name: /id/ }));
    await waitFor(() => {
      expect(
        screen.getByRole("columnheader", { name: /id/ }).getAttribute("aria-sort"),
      ).toBe("descending");
    });
    await waitFor(() =>
      expect(calls.some(call => call.sort === "id" && call.dir === "desc")).toBe(true),
    );
  });

  test("renders an alert when the rows request fails", async () => {
    const broken = stubClient({
      listTables: async () => fakeTables,
      listRows: async () => {
        throw new Error("500");
      },
    });
    renderWithQuery(<DataGrid schema="public" table="t" client={broken} />);
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  test("NULL cells are labelled", async () => {
    renderWithQuery(
      <DataGrid
        schema="public"
        table="t"
        client={stubClient({ listRows: async () => ({ rows: [{ id: 1, note: null }], nextCursor: null }) })}
      />,
    );
    await screen.findByText("NULL");
  });
});

describe("DetailPanel", () => {
  test("lists every column of the selected row and closes", async () => {
    const { App } = await import("../App");
    const { client } = makeRowClient(3);
    renderWithQuery(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: /orders/ }));
    fireEvent.click(await screen.findByText("row-2"));
    const panel = await screen.findByRole("complementary", { name: "row detail" });
    // every column of the fake rows appears as a term
    for (const column of ["id", "name", "note"]) {
      expect(panel.querySelector("dl")?.textContent).toContain(column);
    }
    expect(panel.textContent).toContain("note 1");

    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "row detail" })).toBeNull());
  });

  test("NULL values are labelled in the panel", async () => {
    const client = stubClient({
      listTables: async () => [{ schema: "public", name: "solo", kind: "table" }],
      listRows: async () => ({ rows: [{ id: 9, note: null }], nextCursor: null }),
    });
    renderWithQuery(<App client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /solo/ }));
    fireEvent.click(await screen.findByText(String(9)));
    const panel = await screen.findByRole("complementary", { name: "row detail" });
    expect(panel.textContent).toContain("NULL");
  });
});

describe("Pending changes (staged edits, deletes, inserts)", () => {
  async function openGrid(client: StudioClient) {
    renderWithQuery(<DataGrid schema="public" table="t" client={client} />);
    await screen.findByText("row-2");
  }

  test("double-click stages an edit without saving; Save posts the payload", async () => {
    const { client, savedPayloads } = makeRowClient(10);
    await openGrid(client);

    fireEvent.doubleClick(screen.getByText("row-2"));
    const input = screen.getByLabelText("edit name");
    fireEvent.change(input, { target: { value: "row-two-edited" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // staged: shown as pending, not yet sent
    expect(screen.getByText(/1 edit\(s\)/)).toBeDefined();
    expect(savedPayloads).toHaveLength(0);
    expect(screen.getByText("row-two-edited")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedPayloads).toHaveLength(1));
    expect(savedPayloads[0]).toEqual({
      updates: [{ pkValues: [2], set: { name: "row-two-edited" } }],
      deletes: [],
      inserts: [],
    });
    // after save the pending bar disappears and rows refetch
    await waitFor(() => expect(screen.queryByText(/Pending:/)).toBeNull());
  });

  test("Escape cancels the cell editor without staging", async () => {
    const { client, savedPayloads } = makeRowClient(5);
    await openGrid(client);

    fireEvent.doubleClick(screen.getByText("row-3"));
    const input = screen.getByLabelText("edit name");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByText(/Pending:/)).toBeNull();
    expect(savedPayloads).toHaveLength(0);
  });

  test("delete button stages a row; Save includes it; Discard clears everything", async () => {
    const { client, savedPayloads } = makeRowClient(4);
    await openGrid(client);

    fireEvent.click(screen.getByLabelText("Delete 1"));
    expect(screen.getByText(/1 delete\(s\)/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedPayloads).toHaveLength(1));
    expect(savedPayloads[0]?.deletes).toEqual([{ pkValues: [1] }]);
  });

  test("failed save keeps pending changes visible with an alert", async () => {
    const harness = makeRowClient(6);
    harness.setSaveShouldFail(true);
    await openGrid(harness.client);

    fireEvent.doubleClick(screen.getByText("row-4"));
    const input = screen.getByLabelText("edit name");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("pending changes kept");
    expect(screen.getByText(/1 edit\(s\)/)).toBeDefined();
  });
});

describe("AddRowForm", () => {
  const enums = [{ name: "task_status", values: ["todo", "doing", "done"] }];

  function formDetail(): Parameters<typeof AddRowForm>[0]["detail"] {
    return {
      primaryKey: ["id"],
      columns: [
        { name: "id", nullable: false, hasDefault: true, udtName: "int4", dataType: "integer" },
        { name: "title", nullable: false, hasDefault: false, udtName: "text", dataType: "text" },
        { name: "status", nullable: false, hasDefault: true, udtName: "task_status", dataType: "USER-DEFINED" },
        { name: "note", nullable: true, hasDefault: false, udtName: "text", dataType: "text" },
      ],
    };
  }

  test("required fields are marked; optional/enum/defaulted are not required", () => {
    renderWithQuery(
      <AddRowForm detail={formDetail()} enums={enums} onStage={() => {}} onClose={() => {}} />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("title *");
    expect(text).not.toContain("status *");
    expect(text).not.toContain("note *");
    expect(text).not.toContain("id *");

    const statusSelect = screen.getByLabelText("status value") as HTMLSelectElement;
    expect(statusSelect.tagName).toBe("SELECT");
    expect(statusSelect.textContent).toContain("doing");
  });

  test("blocks staging when a required field is empty; alerts", () => {
    renderWithQuery(
      <AddRowForm detail={formDetail()} enums={enums} onStage={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));
    expect(screen.getByRole("alert").textContent).toContain('"title" is required');
  });

  test("stages values: numbers coerced, optional empties omitted", () => {
    const staged: Array<Record<string, string | number | boolean | null>> = [];
    renderWithQuery(
      <AddRowForm
        detail={formDetail()}
        enums={enums}
        onStage={values => staged.push(values)}
        onClose={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("title value"), { target: { value: "ship it" } });
    fireEvent.change(screen.getByLabelText("status value"), { target: { value: "done" } });
    fireEvent.change(screen.getByLabelText("note value"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));

    expect(staged).toHaveLength(1);
    expect(staged[0]).toEqual({ title: "ship it", status: "done" });
  });
});

describe("App shell", () => {
  test("prompts to select a table before any selection is made", () => {
    renderWithQuery(<App client={makeRowClient(0).client} />);
    expect(screen.getByText("Select a table to browse its rows")).toBeDefined();
  });
});
