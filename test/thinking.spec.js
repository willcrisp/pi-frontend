// The thinking quote: reading the model's reasoning while it is having it.
//
// Reasoning renders collapsed to its latest line, and a click on the quote opens
// the whole thing — the point being to check mid-run that a long turn is on
// track, without the thinking burying the answer when it isn't what you're
// reading.
import { expect, test } from "@playwright/test";

const MOCK = "http://127.0.0.1:4096";

// The reasoning the mock's agent loop streams, word by word.
const THINKING = "Let me check what was asked. It looks routine, so I will just answer it.";

async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".msg-assistant").first().waitFor();
}

test.beforeEach(async ({ page, request }) => {
  await openApp(page);
  // Slow the stream down so the live half of this is observable at all.
  await request.post(`${MOCK}/api/mock/control`, { data: { stepMs: 150 } });
});

test("the live thinking quote previews its newest line and expands on click", async ({ page }) => {
  await page.locator("textarea").fill("think about it");
  await page.locator("textarea").press("Enter");

  const block = page.locator(".thinking-block").last();
  await expect(block).toHaveClass(/live/);
  await expect(block.locator(".thinking-label")).toHaveText("thinking");

  // Collapsed: a preview, not the body.
  await expect(block.locator(".thinking-peek")).toContainText("Let me check");
  await expect(block.locator(".thinking-body")).toHaveCount(0);

  // One click on the quote opens it, mid-run.
  await block.locator(".thinking-head").click();
  await expect(block.locator(".thinking-body")).toBeVisible();
  await expect(block.locator(".thinking-peek")).toHaveCount(0);

  // And it holds the reasoning that streamed, not a truncation of it.
  await expect(block.locator(".thinking-body")).toContainText("Let me check what was asked");
  await expect(page.locator(".msg-assistant").last()).toContainText("Acknowledged.");
});

test("a finished thought collapses again, and says how much is hidden", async ({ page }) => {
  await page.locator("textarea").fill("think about it");
  await page.locator("textarea").press("Enter");

  const block = page.locator(".thinking-block").last();
  // Once the run is over the quote is no longer live, and its label counts what
  // is folded away.
  await expect(page.locator(".composer-icon-btn.send")).toBeVisible({ timeout: 20000 });
  await expect(block).not.toHaveClass(/live/);
  await expect(block.locator(".thinking-label")).toHaveText(`thought · ${THINKING.split(" ").length} words`);
  // Collapsed by default, so the answer is what the transcript leads with.
  await expect(block.locator(".thinking-body")).toHaveCount(0);

  await block.locator(".thinking-head").click();
  await expect(block.locator(".thinking-body")).toContainText(THINKING);
  await block.locator(".thinking-head").click();
  await expect(block.locator(".thinking-body")).toHaveCount(0);
});
