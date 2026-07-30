// The permission gate.
//
// This surface had no coverage at all, which was the wrong place to have none: a
// bug here doesn't degrade the UI, it hangs the agent — the tool call waits for a
// reply that the user was never shown a way to give.
//
// Driven through the mock's event stream (POST /api/mock/emit) rather than by
// stubbing the network, so the real store, dialog and reply route are all in the
// path. See test/mock-opencode.js.
import { expect, test } from "@playwright/test";

const MOCK = "http://127.0.0.1:4096";

const dialog = (page) => page.locator(".permission-panel");

async function ask(request, data) {
  await request.post(`${MOCK}/api/mock/emit`, {
    data: { type: "permission.v2.asked", data },
  });
}

const BASH_ASK = {
  id: "perm_bash",
  sessionID: "ses_mock1",
  action: "bash",
  resources: ["rm -rf dist"],
  save: ["bash:rm"],
  metadata: { command: "rm -rf dist && npm run build", cwd: "/home/user/pi-frontend" },
};

async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test("an ask opens the dialog with its action, resources and saved rule", async ({
  page,
  request,
}) => {
  await ask(request, BASH_ASK);
  await expect(dialog(page)).toBeVisible();

  await expect(page.locator(".permission-action-name")).toHaveText("bash");
  await expect(page.locator(".permission-resources")).toContainText("rm -rf dist");
  // What "always" would persist, which the user is being asked to weigh.
  await expect(page.locator(".permission-hint")).toContainText("bash:rm");

  // The metadata dump is behind a toggle: `resources` above it already says the
  // same thing, and both at once read as two separate requests.
  await expect(page.locator(".permission-metadata")).toBeHidden();
  await page.locator(".permission-detail-toggle").click();
  await expect(page.locator(".permission-metadata")).toContainText("npm run build");
});

test("Allow once replies and closes, and focus starts on it", async ({ page, request }) => {
  const reply = page.waitForRequest(
    (r) => r.url().includes("/permission/perm_bash/reply") && r.method() === "POST"
  );
  await ask(request, BASH_ASK);
  await expect(dialog(page)).toBeVisible();

  // The least-consequential affirmative holds focus, so a reflexive Enter grants
  // once rather than forever.
  await expect(page.locator(".permission-actions button").first()).toBeFocused();
  await page.keyboard.press("Enter");

  expect(JSON.parse((await reply).postData())).toEqual({ reply: "once" });
  await expect(dialog(page)).toBeHidden();
});

test("number keys pick a reply", async ({ page, request }) => {
  const reply = page.waitForRequest(
    (r) => r.url().includes("/permission/perm_bash/reply") && r.method() === "POST"
  );
  await ask(request, BASH_ASK);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("2");

  expect(JSON.parse((await reply).postData())).toEqual({ reply: "always" });
  await expect(dialog(page)).toBeHidden();
});

// Escape is the one key a stray press can't do damage with here: it denies, and
// denial is always recoverable. It must never grant.
test("Escape denies rather than allowing", async ({ page, request }) => {
  const reply = page.waitForRequest(
    (r) => r.url().includes("/permission/perm_bash/reply") && r.method() === "POST"
  );
  await ask(request, BASH_ASK);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");

  expect(JSON.parse((await reply).postData())).toEqual({ reply: "reject" });
  await expect(dialog(page)).toBeHidden();
});

test("a queue says how many are waiting and advances one at a time", async ({ page, request }) => {
  await ask(request, BASH_ASK);
  await ask(request, {
    id: "perm_fetch",
    sessionID: "ses_mock1",
    action: "webfetch",
    resources: ["https://example.com"],
    metadata: {},
  });

  await expect(dialog(page)).toBeVisible();
  // The count is the point: answering this one is immediately followed by
  // another, and that used to be invisible.
  await expect(page.locator(".permission-progress")).toHaveText("1 of 2");
  await expect(page.locator(".permission-action-name")).toHaveText("bash");

  await page.keyboard.press("1");
  await expect(page.locator(".permission-action-name")).toHaveText("webfetch");
  await expect(page.locator(".permission-progress")).toBeHidden();

  await page.keyboard.press("1");
  await expect(dialog(page)).toBeHidden();
});

// A request from a sub-agent, or from a chat that isn't on screen, is the case
// where "approve this" is least likely to mean what the user assumes — the
// sessionID was captured by the store and never rendered.
test("an ask from another session says so", async ({ page, request }) => {
  await ask(request, { ...BASH_ASK, id: "perm_other", sessionID: "ses_mock2" });
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator(".permission-asker")).toHaveClass(/elsewhere/);
  await expect(page.locator(".permission-asker")).toContainText("Second session");
});
