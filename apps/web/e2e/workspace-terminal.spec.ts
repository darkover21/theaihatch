import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let root = "";

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-e2e-"));
  await fs.writeFile(path.join(root, "alpha.ts"), "export const alpha = true;\n", "utf8");
  await fs.writeFile(path.join(root, "beta.ts"), "export const beta = true;\n", "utf8");
});

test.afterEach(async () => {
  if (root !== "") await fs.rm(root, { recursive: true, force: true });
});

test("REQ-EDT-002: Monaco keeps one tab/model per path and restores focus", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Open local folder").fill(root);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: /alpha\.ts/u }).first().click();
  await page.getByRole("button", { name: /beta\.ts/u }).first().click();
  await expect(page.locator(".editor-tab")).toHaveCount(2);
  await page.locator(".editor-tab").filter({ hasText: "alpha.ts" }).click();
  await expect(page.locator(".editor-tab.active")).toContainText("alpha.ts");
});

test("REQ-TRM-005: scripted command reveals a resizable terminal panel", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Open local folder").fill(root);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Run scripted demo" }).click();
  await expect(page.getByLabel("Terminal panel")).toBeVisible();
  await expect(page.locator(".terminal-command")).toContainText("workspace demo complete");
});
