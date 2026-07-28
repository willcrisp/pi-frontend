// useFileMentions: the "@path" autocomplete.
//
// Its file list comes from stores/filesearch.js, which shells out over a PTY —
// something the mock server doesn't implement. So the tests seed filesearch's
// localStorage cache instead, which is the same path a returning user hits and
// keeps the test about the menu rather than about PTY plumbing.
import { expect, test } from "@playwright/test";

const DIRECTORY = "/home/user/pi-frontend"; // matches test/mock-opencode.js
const FILES = [
  "src/components/chat/Composer.vue",
  "src/composables/useAttachments.js",
  "src/stores/opencode/events.js",
  "README.md",
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([dir, files]) => {
      localStorage.setItem(
        "opencode-web:files-cache",
        JSON.stringify({ [dir]: { files, fetchedAt: Date.now() } })
      );
    },
    [DIRECTORY, FILES]
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await expect(page.locator(".controls .model-select")).toBeVisible();
});

test("@ opens the menu over the cached file list", async ({ page }) => {
  await page.locator("textarea").type("please read @");
  await expect(page.locator(".slash-menu li")).toHaveCount(FILES.length);
});

test("a query narrows the list by fuzzy score", async ({ page }) => {
  const ta = page.locator("textarea");
  await ta.type("please read @compos");

  const items = page.locator(".slash-menu li");
  await expect(items).not.toHaveCount(0);
  await expect(items).not.toHaveCount(FILES.length);
  // Both surviving paths contain "compos"; the ranking puts one of them first.
  await expect(items.first()).toContainText(/compos/i);
});

test("Enter inserts @path and keeps the surrounding text", async ({ page }) => {
  const ta = page.locator("textarea");
  await ta.type("please read @compos");
  await ta.press("Enter");

  await expect(ta).toHaveValue(/^please read @\S+ $/);
  await expect(page.locator(".slash-menu li")).toHaveCount(0);
});

test("a mention mid-message is tracked from the caret, not the whole box", async ({ page }) => {
  const ta = page.locator("textarea");
  await ta.fill("check @use and then more");
  // Put the caret back at the end of "@use" — the menu is driven by what sits
  // before the caret, so it must reopen here even though the box has trailing text.
  await ta.evaluate((el) => el.setSelectionRange(10, 10));
  await ta.press("ArrowLeft");
  await ta.press("ArrowRight");

  await expect(page.locator(".slash-menu li")).not.toHaveCount(0);
});

test("Escape closes the menu but keeps the text", async ({ page }) => {
  const ta = page.locator("textarea");
  await ta.type("check @use");
  await expect(page.locator(".slash-menu li")).not.toHaveCount(0);

  await ta.press("Escape");

  // Regression guard: updateMentionState also runs on keyup, so without the
  // dismissed-span check in useFileMentions the keyup after Escape re-detects
  // the same mention and the menu never closes.
  await expect(page.locator(".slash-menu li")).toHaveCount(0);
  await expect(ta).toHaveValue("check @use");
});

test("an email address does not open the menu", async ({ page }) => {
  await page.locator("textarea").type("mail me at user@example.com");
  await expect(page.locator(".slash-menu li")).toHaveCount(0);
});
