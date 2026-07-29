// /handover: compacting a session into a document, and starting the next chat
// from it.
//
// Driven end to end against the canned agent in mock-opencode.js, which answers
// a prompt beginning "Write a HANDOVER DOCUMENT" with a handover-shaped reply
// and settles the run — everything in between (the streaming capture, the id,
// the chip, the dialog, the seeded prompt) is the real code.
import { expect, test } from "@playwright/test";

// Not "networkidle": the SSE stream is deliberately never-ending.
async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".msg-assistant").first().waitFor();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

// Ask for a handover and wait for the chip. Returns its 8-character id.
async function requestHandover(page) {
  await page.locator("textarea").fill("/handover");
  await page.locator("textarea").press("Enter");
  const chip = page.locator(".handover-chip");
  await expect(chip).toHaveCount(1, { timeout: 15000 });
  return (await chip.locator(".handover-chip-id").innerText()).trim();
}

test("writes a handover and files it under an 8-character id", async ({ page }) => {
  const id = await requestHandover(page);
  expect(id).toMatch(/^[0-9a-f]{8}$/);

  // The brief itself is three thousand characters of instructions to the agent;
  // reproducing it in the transcript buries the document it asked for.
  await expect(page.locator(".handover-brief")).toHaveText(/handover requested/);
  await expect(page.locator("textarea")).toHaveValue("");

  // The document stays in the transcript as a readable message — the chip is a
  // handle on it, not a replacement for it.
  await expect(page.locator(".msg-assistant").last()).toContainText("Handover: mock session");
});

test("the chip opens the document, not a new chat", async ({ page }) => {
  const id = await requestHandover(page);
  await page.locator(".handover-chip").click();

  const dialog = page.locator(".handover-panel");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".handover-id")).toHaveText(id);
  await expect(dialog.locator(".handover-doc")).toContainText("Remaining work");
  // Still the same chat: nothing is created until the dialog is confirmed.
  await expect(page.locator(".handover-chip")).toHaveCount(1);

  // Source view exists so the document can be copied out as markdown.
  await dialog.getByRole("button", { name: "Source" }).click();
  await expect(dialog.locator(".handover-source")).toContainText("# Handover: mock session");
});

test("starting from the chip seeds a new chat with the document and the extra notes", async ({
  page,
}) => {
  const id = await requestHandover(page);
  await page.locator(".handover-chip").click();

  const dialog = page.locator(".handover-panel");
  await dialog.locator(".handover-extra").fill("skip the CSS, start with the failing test");
  await dialog.getByRole("button", { name: "Start new chat" }).click();
  await expect(dialog).toHaveCount(0);

  // A chat of its own: one prompt, not the ones the handover was written from.
  await expect(page.locator(".msg-rail li")).toHaveCount(1);

  const seeded = page.locator(".msg-user").first();
  await expect(seeded).toContainText(`handover ${id}`);
  // Both halves are in the seed. A seed that dropped either the document or the
  // user's own instructions would look identical from the outside.
  await expect(seeded).toContainText("Handover: mock session");
  await expect(seeded).toContainText("skip the CSS, start with the failing test");
});

test("the slash menu offers it alongside the other builtins", async ({ page }) => {
  await page.locator("textarea").type("/hand");
  const items = page.locator(".slash-menu li");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("handover");
});
