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

test("REQ-REV-001 and REQ-REV-005: review mode and dry-run proposals remain visible while a run waits", async ({ page }) => {
  const runId = "review-run-1";
  let startBody: Record<string, unknown> | null = null;
  await page.route("**/api/agent/runs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    startBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ runId, checkpointId: "checkpoint-1" }) });
  });
  await page.route(`**/api/agent/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runId,
        checkpointId: "checkpoint-1",
        status: "waiting_for_review",
        events: [],
        pending: { kind: "review", operationId: runId, snapshotId: "snapshot-1", hunks: [{ id: "hunk-1", path: "alpha.ts", startLine: 1, beforeLines: ["export const alpha = true;"], afterLines: ["export const alpha = false;"], fingerprint: "hunk-1", eventSeq: 1 }] },
        proposals: [{ kind: "file", path: "alpha.ts", description: "edit proposed" }],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
        error: null
      })
    });
  });

  await page.goto("/");
  await page.getByLabel("Open local folder").fill(root);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Review each change").check();
  await page.getByLabel("Dry run").check();
  await page.getByRole("textbox", { name: "Agent prompt" }).fill("propose a safe change");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  expect(startBody).toMatchObject({ reviewMode: true, dryRun: true });
  await expect(page.getByText("Dry-run proposals")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept all" })).toBeVisible();
});
