// When the composer comes back.
//
// These assert a specific bug: the send arrow never returned. Mid-run the
// composer swaps its send arrow for a stop square, and nothing was clearing the
// streaming flag afterwards — so after one prompt the chat was read-only, Enter
// steered into a run that had long finished, and every following turn looked like
// an agent that never answered.
//
// The cause was that "the run finished" was read off a single event. No such
// event exists on every build (`opencode-ai@next` ends a turn with
// `session.next.step.ended` and has no session.execution.* at all), and where it
// does exist it is not the end of the loop when a prompt was steered in. The run
// state is now settled against GET /api/session/active, so each case below is
// driven through the mock's agent loop rather than by faking one event.
import { expect, test } from "@playwright/test";

const MOCK = "http://127.0.0.1:4096";

const stop = (page) => page.locator(".composer-icon-btn.stop");
const send = (page) => page.locator(".composer-icon-btn.send");

async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("textarea").waitFor();
  await page.locator(".msg-assistant").first().waitFor();
}

async function control(request, body) {
  await request.post(`${MOCK}/api/mock/control`, { data: body });
}

async function prompt(page, text) {
  await page.locator("textarea").fill(text);
  await page.locator("textarea").press("Enter");
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

for (const vocabulary of ["next", "classic"]) {
  test(`the send arrow comes back after a turn (${vocabulary} event vocabulary)`, async ({
    page,
    request,
  }) => {
    // Set after the page is up: the mock resets its control state whenever a
    // client opens the event stream.
    await control(request, { vocabulary });

    await prompt(page, "are you there");
    await expect(stop(page)).toBeVisible();

    // The reply renders from the stream, and the square becomes an arrow again.
    await expect(page.locator(".msg-assistant").last()).toContainText("Acknowledged.");
    await expect(send(page)).toBeVisible({ timeout: 15000 });
    await expect(stop(page)).toHaveCount(0);

    // And the composer is a composer again: a second prompt is a prompt, not a
    // steer into a finished run.
    await prompt(page, "again please");
    await expect(page.locator(".msg-user").last()).toContainText("again please");
    await expect(send(page)).toBeVisible({ timeout: 15000 });
  });
}

test("steering keeps the run open across the step boundary, then lets go", async ({
  page,
  request,
}) => {
  await control(request, { stepMs: 120 });

  await prompt(page, "first question");
  await expect(stop(page)).toBeVisible();

  // Enter mid-run steers: the prompt is admitted into the loop that is already
  // going, so the box empties but no user message is added yet.
  await page.locator("textarea").fill("actually, also this");
  await page.locator("textarea").press("Enter");
  await expect(page.locator("textarea")).toHaveValue("");
  // Waiting to be read — the steer button says so.
  await expect(page.locator(".composer-icon-btn.steer.waiting")).toBeVisible();

  // The first step ends here, and the loop runs a second one for the steered
  // input. The square must NOT flap back to an arrow in between.
  await expect(page.locator(".composer-icon-btn.steer.waiting")).toHaveCount(0, { timeout: 15000 });
  await expect(stop(page)).toBeVisible();

  // Only when the loop drains does the composer come back — with both turns in
  // the transcript.
  await expect(send(page)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg-user").last()).toContainText("actually, also this");
});

test("a run whose ending is never announced is recovered from server state", async ({
  page,
  request,
}) => {
  // No step.ended, no execution.succeeded: the loop just stops, as it looks from
  // the client when the stream drops mid-turn. Only the poll can settle this.
  await control(request, { dropTerminalEvents: true });

  await prompt(page, "into the void");
  await expect(stop(page)).toBeVisible();
  await expect(send(page)).toBeVisible({ timeout: 20000 });
});

test("a run parked on a question the stream never announced is recovered by the poll", async ({
  page,
  request,
}) => {
  // The agent is blocked mid-step waiting on an answer, but the
  // question.v2.asked event never arrived: the transcript goes quiet, yet
  // /session/active keeps reporting the run — so without the pending-question
  // poll the dialog never shows and the composer sits on stop forever.
  await control(request, { holdForQuestion: true });

  await prompt(page, "need my input");
  await expect(stop(page)).toBeVisible();

  // The poll re-pulls pending questions every few seconds and the dialog
  // surfaces off that, not off the (missing) event.
  await expect(page.locator(".question-panel")).toBeVisible({ timeout: 15000 });
  await page.locator(".question-option", { hasText: "Left" }).click();

  // Answered: the loop drains, the dialog clears, and the composer comes back.
  await expect(page.locator(".question-panel")).toHaveCount(0);
  await expect(page.locator(".msg-assistant").last()).toContainText("Acknowledged.");
  await expect(send(page)).toBeVisible({ timeout: 15000 });
});

test("a rate-limited turn shows the error on the message", async ({
  page,
  request,
}) => {
  await control(request, { failTurn: true });

  await prompt(page, "try anyway");
  await expect(stop(page)).toBeVisible();

  // The run settles and the message-level error renders.
  await expect(page.locator(".msg-error")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg-error")).toContainText("Rate limit exceeded");

  // The red square clears — the run is over.
  await expect(send(page)).toBeVisible({ timeout: 15000 });
});
