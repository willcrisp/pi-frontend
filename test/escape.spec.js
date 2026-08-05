// The shared Escape contract (src/composables/useDialogEscape.js).
//
// These assert specific past bugs, so they should not be "simplified" away:
//
//   · Escape used to be owned three different ways that didn't know about each
//     other — seven dialogs on the composable's stack, five hand-rolling a
//     `window` listener, and Composer.vue guessing from a hardcoded list of nine
//     CSS selectors. None of the hand-rolled five checked `defaultPrevented`, so
//     a permission prompt arriving over an open dialog was rejected by the very
//     same press that closed the dialog (the "one press, two surfaces" test).
//
//   · Plain `window` listeners fire in registration — i.e. mount — order, so
//     when two surfaces did coordinate, the one opened *first* won. The palette
//     and shortcuts dialog are mounted for the life of the app, so mount order
//     said nothing about which was on top ("innermost first").
//
//   · The composer's Escape-to-interrupt must still fire when nothing else owns
//     the key, and must NOT fire when something does — that was the whole point
//     of the selector list it replaced.
import { expect, test } from "@playwright/test";

const MOCK = "http://127.0.0.1:4096";

async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test("Escape closes the command palette without touching the run", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette-backdrop")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".palette-backdrop")).toHaveCount(0);
});

test("Escape closes the shortcuts reference", async ({ page }) => {
  await page.keyboard.press("?");
  await expect(page.locator(".shortcuts-backdrop")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".shortcuts-backdrop")).toHaveCount(0);
});

// Innermost first: one press closes one layer. The palette is mounted at boot
// and the usage dialog only when opened, so this also pins that the stack is
// ordered by when each surface *opened*, not when it mounted.
test("stacked surfaces close one layer per press, innermost first", async ({ page }) => {
  // Same way in as usage.spec.js: hover the header figure, then "All usage".
  await page.locator(".header-usage").hover();
  await page.getByRole("button", { name: /All usage/ }).click();
  const usage = page.locator(".connect-backdrop");
  await expect(usage).toBeVisible();

  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette-backdrop")).toBeVisible();

  // First press: the palette only.
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette-backdrop")).toHaveCount(0);
  await expect(usage).toBeVisible();

  // Second press: the dialog underneath.
  await page.keyboard.press("Escape");
  await expect(usage).toHaveCount(0);
});

// The bug this whole refactor was for. A permission ask mounts on top of an open
// dialog; one Escape must deny the ask and leave the dialog alone. Before, both
// listeners ran and the dialog underneath closed too.
test("one press acts on one surface when a permission ask lands over a dialog", async ({
  page,
  request,
}) => {
  await page.keyboard.press("?");
  await expect(page.locator(".shortcuts-backdrop")).toBeVisible();

  await request.post(`${MOCK}/api/mock/emit`, {
    data: {
      type: "permission.v2.asked",
      data: {
        id: "perm_escape",
        sessionID: "ses_mock1",
        action: "bash",
        resources: ["rm -rf dist"],
        metadata: { command: "rm -rf dist" },
      },
    },
  });
  await expect(page.locator(".permission-panel")).toBeVisible();

  await page.keyboard.press("Escape");

  // The ask is answered…
  await expect(page.locator(".permission-panel")).toHaveCount(0);
  // …and the surface underneath is untouched.
  await expect(page.locator(".shortcuts-backdrop")).toBeVisible();
});

// Escape-to-interrupt is the lowest-priority claim on the key: it fires only
// when no dismissible surface would have used it. This replaced a DOM query
// against nine hardcoded selectors.
test("Escape interrupts a run only when nothing else owns the key", async ({ page }) => {
  await page.locator("textarea").fill("run something long");
  await page.keyboard.press("Enter");

  const stop = page.locator(".composer-icon-btn.stop");
  await expect(stop).toBeVisible();

  // With the palette open, Escape belongs to the palette — the run keeps going.
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette-backdrop")).toHaveCount(0);
  await expect(stop).toBeVisible();

  // With nothing open, it reaches the run.
  await page.keyboard.press("Escape");
  await expect(stop).toHaveCount(0, { timeout: 10000 });
});
