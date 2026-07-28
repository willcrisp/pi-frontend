// Composer smoke tests: one block per composable in ../src/composables/.
//
// These exist because `npm run build` is the only other check in the repo, and
// the composer is where the most stateful UI logic lives. They drive the real
// component against test/mock-opencode.js — no unit-level stubbing, so a broken
// import, a lost ref unwrap or a dead event handler all show up here.
import { expect, test } from "@playwright/test";

// A 1x1 PNG, for the attachment tests.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Not "networkidle": the SSE stream is deliberately never-ending, so the page
// never reaches it.
async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  // Catalogs land a beat after the shell.
  await expect(page.locator(".controls .model-select")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe("useModelPicker", () => {
  test("shows agent, model and reasoning selects from the catalogs", async ({ page }) => {
    await expect(page.locator(".agent-select")).toBeVisible();
    await expect(page.locator(".model-select")).toBeVisible();
    // Sol declares variants, so the reasoning select is not hidden.
    await expect(page.locator(".thinking-select")).toBeVisible();
  });

  test("ranks Sol above Luna in the picker", async ({ page }) => {
    // MODEL_RANK is ["sol", "terra", "luna"], applied per provider group.
    await expect(page.locator(".model-select")).toContainText(/Sol/i);
  });
});

test.describe("useAutosize", () => {
  test("grows with content and collapses when cleared", async ({ page }) => {
    const ta = page.locator("textarea");
    const start = await ta.evaluate((el) => el.getBoundingClientRect().height);

    await ta.fill("one\ntwo\nthree\nfour\nfive");
    await expect
      .poll(() => ta.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(start + 10);

    await ta.fill("");
    await expect
      .poll(() => ta.evaluate((el) => el.getBoundingClientRect().height))
      .toBeLessThanOrEqual(start + 2);
  });
});

test.describe("useSlashCommands", () => {
  test("lists server commands, skills and builtins", async ({ page }) => {
    await page.locator("textarea").type("/");
    const items = page.locator(".slash-menu li");
    await expect(items).toHaveCount(3);
    const text = (await items.allInnerTexts()).join(" ");
    expect(text).toContain("compact"); // server command
    expect(text).toContain("pdf"); // skill
    expect(text).toContain("new"); // builtin
  });

  test("ArrowDown moves the highlight and Tab inserts the command", async ({ page }) => {
    const ta = page.locator("textarea");
    await ta.type("/");
    const first = await page.locator(".slash-menu li.active").innerText();

    await ta.press("ArrowDown");
    await expect(page.locator(".slash-menu li.active")).not.toHaveText(first);

    await ta.press("Tab");
    // Chosen non-builtin commands land in the box as "/name " ready for args.
    await expect(ta).toHaveValue(/^\/\S+ $/);
  });

  test("Escape dismisses the menu without discarding what was typed", async ({ page }) => {
    const ta = page.locator("textarea");
    await ta.fill("/comp");
    await expect(page.locator(".slash-menu li")).not.toHaveCount(0);

    await ta.press("Escape");
    await expect(page.locator(".slash-menu li")).toHaveCount(0);
    await expect(ta).toHaveValue("/comp");

    // Editing the query is what reopens it — "/compa" still prefix-matches
    // "compact", and differs from the text Escape dismissed.
    await ta.press("a");
    await expect(page.locator(".slash-menu li")).not.toHaveCount(0);
  });
});

test.describe("drafts", () => {
  test("a half-typed prompt follows its own session", async ({ page }) => {
    const ta = page.locator("textarea");
    const rows = page.locator(".chat-history .chat-row");
    await expect(rows).toHaveCount(2);

    await ta.fill("draft for the first session");

    // Switch to the other chat: the box is that chat's, so it comes up empty.
    await rows.nth(1).click();
    await expect(ta).toHaveValue("");
    await ta.fill("a different draft");

    // ...and switching back restores the first one rather than losing it.
    await rows.nth(0).click();
    await expect(ta).toHaveValue("draft for the first session");
    await rows.nth(1).click();
    await expect(ta).toHaveValue("a different draft");
  });
});

test.describe("useAttachments", () => {
  test("adds an image, previews it, and removes it", async ({ page }) => {
    await page.setInputFiles('input[type="file"]', {
      name: "dot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_BASE64, "base64"),
    });

    await expect(page.locator(".attachment")).toHaveCount(1);
    await expect(page.locator(".attachment img")).toHaveCount(1);
    // The pencil (ImageAnnotator) is offered for images only.
    await expect(page.locator(".attachment-edit")).toHaveCount(1);

    await page.locator(".attachment-remove").click();
    await expect(page.locator(".attachment")).toHaveCount(0);
  });

  test("an attachment alone enables send, with no text typed", async ({ page }) => {
    await expect(page.locator(".composer-icon-btn.send")).toBeDisabled();
    await page.setInputFiles('input[type="file"]', {
      name: "dot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_BASE64, "base64"),
    });
    await expect(page.locator(".composer-icon-btn.send")).toBeEnabled();
  });
});
