import { expect, test } from "@playwright/test";

test("loads the Postgres Studio shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Postgres Studio/i);
});
