// The usage dialog: history aggregated from the session list.
//
// No new server route is involved — SessionV2.Info already meters every session
// with `cost` and `tokens`, so everything here comes from the same GET /session
// the sidebar loads. The mock's richer multi-project history is opt-in through
// /api/mock/control, because the default two-session list is what the sidebar
// specs count.
import { expect, test } from "@playwright/test";

// The mock directly, not through the Vite proxy — same as run-lifecycle.spec.js.
const MOCK = "http://127.0.0.1:4096";

async function openUsage(page, { richHistory = false } = {}) {
  if (richHistory) {
    await page.request.post(`${MOCK}/api/mock/control`, { data: { richHistory: true } });
  }
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".header-usage").hover();
  await page.getByRole("button", { name: /All usage/ }).click();
  return page.locator(".connect-panel").filter({ hasText: "Usage" }).first();
}

// The seed outlives a page load by design, so each test puts it back.
test.afterEach(async ({ page }) => {
  await page.request.post(`${MOCK}/api/mock/control`, { data: { richHistory: false } });
});

test("totals the metered sessions the app already fetched", async ({ page }) => {
  const dialog = await openUsage(page);

  // The two seeded sessions cost 0.42 and 0.17.
  await expect(dialog.locator(".usage-tile").first()).toContainText("$0.59");
  await expect(dialog.locator(".usage-tile").nth(2)).toContainText("2");
});

test("breaks spend down by project", async ({ page }) => {
  const dialog = await openUsage(page, { richHistory: true });

  // Three distinct directories across the history; the busiest leads.
  const projects = dialog.locator(".connect-head", { hasText: "By project" });
  await expect(projects).toBeVisible();
  await expect(dialog.locator(".agents-row").first()).toContainText("api-gateway");
});

test("charts a day per bucket rather than one bar for all of history", async ({ page }) => {
  const dialog = await openUsage(page, { richHistory: true });

  // Timestamps are real milliseconds in the mock: a seconds-based one would
  // bucket every session into 1970-01-01 and collapse the chart to a single bar.
  const bars = dialog.locator(".usage-bar-slot");
  expect(await bars.count()).toBeGreaterThan(3);

  // And the bars have to actually be drawn. Counting slots alone passed against
  // a chart that rendered completely empty, because .connect-panel is a flex
  // column and shrank the fixed-height chart box to nothing.
  const tallest = await dialog
    .locator(".usage-bar")
    .evaluateAll((els) => Math.max(...els.map((el) => el.getBoundingClientRect().height)));
  expect(tallest).toBeGreaterThan(20);
});

test("lists the most expensive sessions", async ({ page }) => {
  const dialog = await openUsage(page, { richHistory: true });

  const top = dialog.locator(".connect-head", { hasText: "Most expensive sessions" });
  await expect(top).toBeVisible();
  // 2.41 is the largest seeded cost.
  await expect(dialog).toContainText("$2.41");
});
