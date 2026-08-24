import { expect, test } from "@playwright/test";

test("loads the studio, opens a table, and shows seeded rows", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Postgres Studio/i);

  const sidebar = page.getByRole("navigation", { name: "tables" });
  await expect(sidebar.getByRole("heading", { name: "public" })).toBeVisible();

  // Seeded fixture: public.orders exists in both schemas' listings; pick it.
  await sidebar.getByRole("button", { name: "orders", exact: true }).click();

  // Composite PK columns render as headers; keyset page loads seed rows.
  await expect(page.getByRole("columnheader", { name: /shop_id/ })).toBeVisible();
  await expect(page.getByRole("grid")).toContainText("150.00");
});
