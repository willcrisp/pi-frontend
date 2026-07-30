// The work profile: the radar, and the three tiers that fill it in.
//
// Everything here drives the real dialog against test/mock-opencode.js — the
// session list for the free title pass, the seeded transcript for the scan, and
// the mock's agent loop for the model pass (it recognises the classifier prompt
// and answers JSON, wrapped in a code fence the way a real model tends to).
import { expect, test } from "@playwright/test";

const MOCK = "http://127.0.0.1:4096";

async function openProfile(page, { richHistory = false } = {}) {
  if (richHistory) {
    await page.request.post(`${MOCK}/api/mock/control`, { data: { richHistory: true } });
  }
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".work-chip").click();
  return page.locator(".connect-panel").filter({ hasText: "Work profile" }).first();
}

test.afterEach(async ({ page }) => {
  await page.request.post(`${MOCK}/api/mock/control`, { data: { richHistory: false } });
});

test("classifies the history from session titles alone, with no extra request", async ({
  page,
}) => {
  const dialog = await openProfile(page, { richHistory: true });

  // "Chase a flaky test", "Draft the release notes", "Tidy the CI workflow" and
  // "Port the auth middleware" are all callable from their titles, so the radar
  // has a shape before anything is scanned.
  await expect(dialog.locator(".wp-radar")).toBeVisible();
  await expect(dialog).toContainText(/rest(s)? on the session title alone/);

  const rows = dialog.locator(".wp-bars li");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBe(8);
});

test("draws a polygon with actual area, not an empty chart", async ({ page }) => {
  const dialog = await openProfile(page, { richHistory: true });

  // The usage chart shipped once as an empty box because .connect-panel is a
  // flex column and collapsed it, so presence is not the assertion — size is.
  const box = await dialog.locator(".wp-radar").boundingBox();
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(100);

  // A polygon whose vertices are all at the centre would still be "visible".
  const spread = await dialog.locator("polygon.wp-shape").first().evaluate((el) => {
    const pts = el.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  });
  expect(spread).toBeGreaterThan(20);
});

test("scanning a transcript beats the title it had", async ({ page }) => {
  const dialog = await openProfile(page);

  // The whole case for tier 2, in one session. "Mock session" reads as 100%
  // TESTING from its title, on the strength of the word "mock" — confidently,
  // and wrongly. Its transcript edits README.md, and the scan says docs.
  const row = dialog.locator(".agents-row", { hasText: "Mock session" }).first();
  await expect(row.locator(".wp-source")).toHaveText("title only");
  await expect(row).toContainText("Testing 100%");

  await dialog.getByRole("button", { name: /Scan \d+ transcript/ }).click();
  await expect(row.locator(".wp-source")).toHaveText("transcript", { timeout: 15000 });
  await expect(row).toContainText("Docs");
});

test("asks the model about what the regexes can't call, and keeps its answer", async ({ page }) => {
  const dialog = await openProfile(page);

  const row = dialog.locator(".agents-row", { hasText: "Second session" }).first();
  await expect(row).toContainText("unclassified");

  await dialog.getByRole("button", { name: /Ask the model about \d+ unclear/ }).click();
  // The mock answers {"security": 70, "backend": 30} to any classifier prompt.
  await expect(row.locator(".wp-source")).toHaveText("model", { timeout: 30000 });
  await expect(row).toContainText("Security");
});

test("keeps the classifier's own session out of the sidebar", async ({ page }) => {
  const dialog = await openProfile(page);

  await dialog.getByRole("button", { name: /Ask the model about \d+ unclear/ }).click();
  await expect(dialog.locator(".wp-source.model").first()).toBeVisible({ timeout: 30000 });
  await page.keyboard.press("Escape");

  // The classifier runs in a session of its own and V2 has no delete route, so
  // if it ever reached the sidebar it would sit there forever.
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar")).not.toContainText("New session");
});

test("labels the chat on screen with the work it reads as", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();

  // ses_mock1's transcript is already in memory — the chip classifies from it
  // without a request of its own, and its edit call touched README.md.
  await expect(page.locator(".work-chip")).toHaveText(/docs/i);
});
