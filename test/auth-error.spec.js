// A turn killed by the model provider's expired credentials.
//
// This is the GitHub Copilot case: OpenCode caches the short-lived Copilot API
// token it exchanges, so a long-running `opencode2 serve` starts answering
// prompts with "invalid auth header" while the same prompt from a fresh
// `opencode` process still works. The frontend can't renew the token — see
// src/lib/autherror.js — so what it owes the user is the cause and the retry,
// rather than passing the provider's bare complaint through.
import { expect, test } from "@playwright/test";

const MOCK = "http://127.0.0.1:4096";

async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".msg-assistant").first().waitFor();
}

async function control(request, data) {
  await request.post(`${MOCK}/api/mock/control`, { data });
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test("a provider auth failure explains itself and offers the prompt back", async ({
  page,
  request,
}) => {
  await control(request, { failWith: "invalid auth header", stepMs: 10 });

  await page.locator("textarea").fill("summarise this repo");
  await page.locator("textarea").press("Enter");

  // The provider's own words stay the headline...
  const banner = page.locator(".process-error-banner");
  await expect(banner).toContainText("invalid auth header");
  // ...with the explanation under it. Nothing here mentions Copilot, so this is
  // the generic reading: a token the server is still caching.
  await expect(banner.locator(".process-error-hint")).toContainText(
    "rejected OpenCode's credentials"
  );

  // Retry appears only once the run has settled — which no event announces, so
  // it waits on the GET /session/active poll in stores/opencode/run.js.
  const retry = banner.locator(".process-error-retry");
  await expect(retry).toBeVisible();

  // The server has since exchanged a fresh token: the same prompt now answers.
  await control(request, { failWith: null });
  await retry.click();

  await expect(page.locator(".msg-assistant").last()).toContainText("Acknowledged");
  await expect(banner).toHaveCount(0);
  // Re-sent verbatim, without the user having to retype it.
  await expect(page.locator(".msg-user").last()).toContainText("summarise this repo");
});

test("a Copilot failure names the token exchange behind it", async ({ page, request }) => {
  await control(request, {
    failWith: "GitHub Copilot request failed: invalid auth header",
    stepMs: 10,
  });

  await page.locator("textarea").fill("what changed here");
  await page.locator("textarea").press("Enter");

  const hint = page.locator(".process-error-banner .process-error-hint");
  await expect(hint).toContainText("short-lived");
  await expect(hint).toContainText("restart the OpenCode server");
});

test("dismissing clears the hint with the error", async ({ page, request }) => {
  await control(request, { failWith: "invalid auth header", stepMs: 10 });

  await page.locator("textarea").fill("anything");
  await page.locator("textarea").press("Enter");

  const banner = page.locator(".process-error-banner");
  await expect(banner.locator(".process-error-hint")).toBeVisible();
  await banner.locator(".process-error-dismiss").click();
  await expect(banner).toHaveCount(0);
});
