import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
import { DetailPanel } from "./DetailPanel";
import { AddRowForm } from "./AddRowForm";
import { FKDrawer, type DrawerTarget } from "./FKDrawer";
import { HistoryPanel } from "./HistoryPanel";
import { App } from "../App";
import type { BatchSnapshots, CellValue, Row, RowsQuery, StudioClient, TableMeta } from "../api";

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
    outgoingReferences: async () => ({ outgoing: [] }),
    incomingReferences: async () => ({ groups: [] }),
    getInferredRelations: async () => [],
    listHistory: async () => [],
    getBatchSnapshots: async () => ({
      batch: { id: "b", createdAt: "", description: null, status: "confirmed" },
      snapshots: [],
    }),
    restoreBatch: async () => ({ batchId: "b", restoredDeletes: 0, restoredInserts: 0, restoredUpdates: 0 }),
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
    outgoingReferences: async () => ({ outgoing: [] }),
    incomingReferences: async () => ({ groups: [] }),
    getInferredRelations: async () => [],
    listHistory: async () => [],
    getBatchSnapshots: async () => ({
      batch: { id: "b", createdAt: "", description: null, status: "confirmed" },
      snapshots: [],
    }),
    restoreBatch: async () => ({ batchId: "b", restoredDeletes: 0, restoredInserts: 0, restoredUpdates: 0 }),
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
    // Phase 3: deletes route through the FK-impact confirmation first.
    await screen.findByRole("alertdialog", { name: "Confirm delete" });
    const confirm = await screen.findByRole("button", { name: "Confirm deletes and save" });
    fireEvent.click(confirm);
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

describe("FKDrawer", () => {
  function referenceClient(log: { navigated: DrawerTarget[]; loadedMore: number[]; inferredCalls?: number[] }) {
    const base = makeRowClient(3);
    return {
      client: {
        ...base.client,
        outgoingReferences: async () => ({
          outgoing: [
            {
              constraintName: "employees_manager_fkey",
              parentSchema: "public",
              parentTable: "employees",
              parentColumns: ["id"],
              preview: { row: { id: 1, name: "Ada Lovelace" }, displayColumn: "name" },
            },
            {
              constraintName: "null_ref",
              parentSchema: "public",
              parentTable: "ghosts",
              parentColumns: ["id"],
              preview: null,
            },
          ],
        }),
        incomingReferences: async (_s, _t, _pk, offset = 0) => {
          if (offset > 0) log.loadedMore.push(offset);
          return {
            groups: [
              {
                constraintName: "employees_manager_fkey",
                childSchema: "public",
                childTable: "employees",
                childColumns: ["manager_id"],
                totalCount: 3,
                rows: [{ id: 2, name: "Grace Hopper" }, { id: 3, name: "Alan Turing" }],
                nextOffset: offset + 2 < 3 ? offset + 2 : null,
              },
            ],
          };
        },
        getInferredRelations: async () => {
          log.inferredCalls?.push(1);
          return [
            {
              column: "delivery_address_id",
              parentSchema: "public",
              parentTable: "addresses",
              confidence: "strong" as const,
            },
          ];
        },
      } as StudioClient,
      savedPayloads: base.savedPayloads,
    };
  }

  const target: DrawerTarget = { schema: "public", table: "employees", pkValues: [2] };

  test("shows outgoing previews and count badges; NULL refs labeled", async () => {
    const { client } = referenceClient({ navigated: [], loadedMore: [] });
    renderWithQuery(
      <FKDrawer target={target} client={client} onNavigate={() => {}} onClose={() => {}} />,
    );

    expect(await screen.findByText("Ada Lovelace")).toBeDefined();
    expect(screen.getByText("NULL reference")).toBeDefined();
    expect(await screen.findByLabelText("3 referencing rows")).toBeDefined();
  });

  test("preview click-through navigates by the parent's referenced columns", async () => {
    const navigated: DrawerTarget[] = [];
    const { client } = referenceClient({ navigated, loadedMore: [] });
    renderWithQuery(
      <FKDrawer target={target} client={client} onNavigate={t => navigated.push(t)} onClose={() => {}} />,
    );

    fireEvent.click(await screen.findByText("Ada Lovelace"));
    expect(navigated).toEqual([{ schema: "public", table: "employees", pkValues: [1] }]);
  });

  test("expanding a group lists children and paginates via Load more", async () => {
    const log = { navigated: [] as DrawerTarget[], loadedMore: [] as number[] };
    const { client } = referenceClient(log);
    renderWithQuery(
      <FKDrawer target={target} client={client} onNavigate={() => {}} onClose={() => {}} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /referencing rows/ }));
    expect(await screen.findByRole("button", { name: /Grace Hopper/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /1 left/ })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(log.loadedMore).toEqual([2]));
  });

  test("child-row click-through uses the child table's primary key", async () => {
    const navigated: DrawerTarget[] = [];
    const { client } = referenceClient({ navigated, loadedMore: [] });
    renderWithQuery(
      <FKDrawer target={target} client={client} onNavigate={t => navigated.push(t)} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /referencing rows/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    expect(navigated[navigated.length - 1]).toEqual({
      schema: "public",
      table: "employees",
      pkValues: [2],
    });
  });

  describe("Inferred relationships toggle", () => {
    const ordersTarget: DrawerTarget = { schema: "public", table: "orders", pkValues: [1, 100] };

    test("off by default — heuristics endpoint never fetched", async () => {
      const log = { navigated: [] as DrawerTarget[], loadedMore: [] as number[], inferredCalls: [] as number[] };
      const { client } = referenceClient(log);
      renderWithQuery(
        <FKDrawer target={ordersTarget} client={client} onNavigate={() => {}} onClose={() => {}} />,
      );

      await screen.findByText("Ada Lovelace"); // drawer settled
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(log.inferredCalls).toEqual([]);
      expect(screen.queryByText("Inferred relationships")).toBeNull();
    });

    test("toggling on shows dashed, labeled inferred rows (distinct from real FKs)", async () => {
      const log = { navigated: [] as DrawerTarget[], loadedMore: [] as number[], inferredCalls: [] as number[] };
      const { client } = referenceClient(log);
      renderWithQuery(
        <FKDrawer target={ordersTarget} client={client} onNavigate={() => {}} onClose={() => {}} />,
      );

      fireEvent.click(await screen.findByLabelText("Show inferred relationships"));
      expect(await screen.findByText("Inferred relationships")).toBeDefined();
      const entry = await screen.findByText(/delivery_address_id → public\.addresses/);
      // visually distinct: dashed border + italic
      expect((entry.closest("li") as HTMLElement).className).toContain("border-dashed");
      expect(screen.getByText(/inferred, strong/)).toBeDefined();
      expect(log.inferredCalls.length).toBeGreaterThan(0);
    });
  });
});

describe("FK navigation guard (App)", () => {
  function navClient(): StudioClient {
    return stubClient({
      listTables: async () => [{ schema: "public", name: "t", kind: "table" }],
      listRows: async () => ({ rows: [{ id: 1, name: "row-1" }], nextCursor: null }),
      outgoingReferences: async (_schema, _table, pkValues) => ({
        outgoing: [
          {
            constraintName: "fk",
            parentSchema: "public",
            parentTable: "employees",
            parentColumns: ["id"],
            preview: {
              row: { id: pkValues[0] === 1 ? 1 : 2, name: pkValues[0] === 1 ? "Ada" : "Grace" },
              displayColumn: "name",
            },
          },
        ],
      }),
      incomingReferences: async (_s, _t, pkValues) => ({
        groups:
          Number(pkValues[0]) === 1
            ? [
                {
                  constraintName: "self_fk",
                  childSchema: "public",
                  childTable: "employees",
                  childColumns: ["id"],
                  totalCount: 1,
                  rows: [{ id: 2, name: "Grace Hopper" }],
                  nextOffset: null,
                },
              ]
            : [],
      }),
    });
  }

  test("A→B→C then returning to B truncates forward history (loop-safe breadcrumbs)", async () => {
    renderWithQuery(<App client={navClient()} />);

    // select the table, then open the drawer at t(1)
    fireEvent.click(await screen.findByRole("button", { name: /t/ }));
    fireEvent.click(await screen.findByLabelText(/^References \[/));
    expect(await screen.findByText("(1)")).toBeDefined();

    // navigate to employees(1)
    fireEvent.click(screen.getByText("Ada"));
    expect(await screen.findByText("(1)")).toBeDefined();

    // navigate to employees(2) via self-fk group
    fireEvent.click(screen.getByRole("button", { name: /referencing rows/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    expect(await screen.findByText("(2)")).toBeDefined();

    // back → (1); Back hidden after popping to depth 1
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("(1)")).toBeDefined();

    // click Ada again → employees(1): visited dedupe keeps stack [t(1), e(1)]
    fireEvent.click(screen.getByText("Ada"));
    expect(await screen.findByText("(1)")).toBeDefined();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined(); // t(1) behind

    // Back returns all the way to the original grid-centered drawer
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("(1)")).toBeDefined(); // t(1) header
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull(); // root reached
  });

  test("closing the drawer clears history", async () => {
    renderWithQuery(<App client={navClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: /t/ }));
    fireEvent.click(await screen.findByLabelText(/^References \[/));
    fireEvent.click(await screen.findByText("Ada"));
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("complementary", { name: "fk drawer" })).toBeNull();
  });
});

describe("Delete confirmation with FK impact counts", () => {
  function impactClient(log: { saved: boolean }) {
    const harness = makeRowClient(2);
    return {
      client: {
        ...harness.client,
        incomingReferences: async (_schema: string, _table: string, pkValues: CellValue[]) => ({
          groups:
            Number(pkValues[0]) === 1
              ? [
                  {
                    constraintName: "fk_addresses",
                    childSchema: "public",
                    childTable: "addresses",
                    childColumns: ["customer_id"],
                    totalCount: 3,
                    rows: [],
                    nextOffset: null,
                  },
                ]
              : [],
        }),
        saveRows: async (...args: Parameters<StudioClient["saveRows"]>) => {
          log.saved = true;
          return harness.client.saveRows(...args);
        },
      } as StudioClient,
    };
  }

  test("saving a delete first shows per-table impact counts, commit only on confirm", async () => {
    const log = { saved: false };
    const { client } = impactClient(log);
    renderWithQuery(
      <DataGrid schema="public" table="customers" client={client} onOpenHistory={() => {}} />,
    );

    fireEvent.click(await screen.findByLabelText(/^Delete 1$/)); // stage row pk=1

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm delete" });
    expect(dialog).toBeDefined();
    expect(await screen.findByText(/3 row\(s\) in/)).toBeDefined();
    expect(screen.getByText("addresses", { selector: "span" })).toBeDefined();
    expect(log.saved).toBe(false); // nothing sent yet

    fireEvent.click(screen.getByRole("button", { name: "Confirm deletes and save" }));
    await waitFor(() => expect(log.saved).toBe(true));
  });

  test("cancel closes the dialog without saving", async () => {
    const log = { saved: false };
    const { client } = impactClient(log);
    renderWithQuery(
      <DataGrid schema="public" table="customers" client={client} onOpenHistory={() => {}} />,
    );

    fireEvent.click(await screen.findByLabelText(/^Delete 1$/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alertdialog", { name: "Confirm delete" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(log.saved).toBe(false);
  });
});

describe("HistoryPanel", () => {
  function historyClient() {
    const base = stubClient();
    return {
      client: {
        ...base,
        listHistory: async () => [
          { id: "batch-1", createdAt: new Date(2026, 7, 25, 10, 0).toISOString(), description: "public.orders" },
        ],
        getBatchSnapshots: async (batchId: string): Promise<BatchSnapshots> => {
          expect(batchId).toBe("batch-1");
          return {
            batch: { id: "batch-1", createdAt: "", description: "public.orders", status: "confirmed" },
            snapshots: [
              {
                id: 1,
                schema: "public",
                table: "orders",
                pkValues: [1, 100],
                operation: "update" as const,
                beforeImage: { total: 150 },
                afterImage: { total: 999 },
              },
              {
                id: 2,
                schema: "public",
                table: "addresses",
                pkValues: [1],
                operation: "delete" as const,
                beforeImage: { id: 1, line: "12 Analytical St" },
                afterImage: null,
              },
            ],
          };
        },
      },
    };
  }

  test("lists batches, shows snapshot diffs, and restores from the panel", async () => {
    let restoredId: string | null = null;
    const base = historyClient();
    const client: StudioClient = {
      ...base.client,
      restoreBatch: async batchId => {
        restoredId = batchId;
        return { batchId, restoredDeletes: 1, restoredInserts: 0, restoredUpdates: 1 };
      },
    };

    renderWithQuery(<HistoryPanel client={client} onClose={() => {}} />);

    fireEvent.click(await screen.findByText("public.orders"));
    expect(await screen.findByText(/DELETE/i)).toBeDefined();
    expect(screen.getByText(/total: 150 → 999/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Restore batch/ }));
    await waitFor(() => expect(restoredId).toBe("batch-1"));
    expect(await screen.findByRole("status")).toBeDefined();
  });

  test("empty history renders an empty-state message", async () => {
    renderWithQuery(<HistoryPanel client={stubClient()} onClose={() => {}} />);
    expect(await screen.findByText("No restorable changes yet.")).toBeDefined();
  });
});

describe("Global search (sidebar)", () => {
  function searchableClient(log: { openedRow: Array<{ schema: string; table: string; pkValues: CellValue[] }> }) {
    return stubClient({
      listTables: async () => [{ schema: "public", name: "t", kind: "table" }],
      globalSearch: async query =>
        query === "ada"
          ? {
              results: [
                {
                  schema: "public",
                  table: "employees",
                  pkColumns: ["id"],
                  pkValues: [1],
                  matchedColumn: "name",
                  snippet: "Ada Lovelace",
                },
              ],
              total: 1,
              nextOffset: null,
            }
          : { results: [], total: 0, nextOffset: null },
    });
  }

  test("submitting a query lists hits; clicking one opens that row", async () => {
    const log = { openedRow: [] as Array<{ schema: string; table: string; pkValues: CellValue[] }> };
    const client = searchableClient(log);
    renderWithQuery(
      <Sidebar client={client} selected={null} onSelect={() => {}} onOpenRow={(schema, table, pkValues) => log.openedRow.push({ schema, table, pkValues })} />,
    );

    const input = await screen.findByLabelText("Search all tables");
    fireEvent.change(input, { target: { value: "ada" } });
    fireEvent.submit(input.closest("form")!);

    const hit = await screen.findByRole("button", { name: /Ada Lovelace/ });
    fireEvent.click(hit);
    expect(log.openedRow).toEqual([{ schema: "public", table: "employees", pkValues: [1] }]);
  });

  test("no matches renders an empty state", async () => {
    const client = searchableClient({ openedRow: [] });
    renderWithQuery(<Sidebar client={client} selected={null} onSelect={() => {}} />);

    const input = await screen.findByLabelText("Search all tables");
    fireEvent.change(input, { target: { value: "zzz" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("No matches")).toBeDefined();
  });
});

describe("App shell", () => {
  test("prompts to select a table before any selection is made", () => {
    renderWithQuery(<App client={makeRowClient(0).client} />);
    expect(screen.getByText("Select a table to browse its rows")).toBeDefined();
  });
});
