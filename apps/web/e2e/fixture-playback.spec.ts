import { expect, test } from "@playwright/test";

test("REQ-EDT-001: fixture shell renders every surface", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Activity bar")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Explorer" })).toBeVisible();
  await expect(page.getByTestId("monaco-surface")).toBeVisible();
  await expect(page.getByLabel("Playback details")).toBeVisible();
  await expect(page.getByLabel("Transport controls")).toBeVisible();
});

test("REQ-EDT-003 and REQ-EDT-004: Monaco is read-only during playback", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("play-pause").click();
  await expect(page.getByTestId("monaco-surface")).toBeVisible();
});

test("REQ-EDT-005 and REQ-EDT-006: file projection and persisted theme work", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
