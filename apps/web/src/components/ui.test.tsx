import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
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

function makeRowClient(totalRows: number, pageSize = 50) {
  const calls: RowsQuery[] = [];
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
  };
  return { client, calls };
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
    const broken: StudioClient = {
      listTables: async () => {
        throw new Error("boom");
      },
      listRows: async () => ({ rows: [], nextCursor: null }),
    };
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
    const broken: StudioClient = {
      listTables: async () => fakeTables,
      listRows: async () => {
        throw new Error("500");
      },
    };
    renderWithQuery(<DataGrid schema="public" table="t" client={broken} />);
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  test("NULL cells are labelled", async () => {
    const client: StudioClient = {
      listTables: async () => [],
      listRows: async () => ({
        rows: [{ id: 1, note: null }],
        nextCursor: null,
      }),
    };
    renderWithQuery(<DataGrid schema="public" table="t" client={client} />);
    await screen.findByText("NULL");
  });
});

describe("App shell", () => {
  test("prompts to select a table before any selection is made", () => {
    renderWithQuery(<App client={makeRowClient(0).client} />);
    expect(screen.getByText("Select a table to browse its rows")).toBeDefined();
  });
});
