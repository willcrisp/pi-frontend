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

// --- When the stream itself is what failed -----------------------------------
//
// These assert a second bug with the same symptom as the first: the turn stops
// on screen and never comes back. Not because the run's ending was missed this
// time — the run is still going — but because the connection carrying it died
// and nothing noticed. Everything the UI knows mid-turn arrives on that one SSE
// stream, so a stream that has quietly stopped delivering is indistinguishable
// from an agent that has stopped thinking: the thinking block sits on its last
// delta until the page is reloaded.
//
// Both cases below set `hangRun`, which keeps the session in
// GET /session/active forever. That rules out the poll: it is the frontend's
// other recovery path, and without this every stream fault would look fixed
// because the run settled a few seconds later and refreshed the transcript.
// Anything that reaches the screen here got there because the stream came back.
test("a stream the server closes mid-turn is reconnected, and the rest of the turn lands", async ({
  page,
  request,
}) => {
  // A clean end of response — an idle proxy, a tunnel, a load balancer. There is
  // no error: `fetch-event-source` calls onclose and, left to itself, stops.
  await control(request, { cutStream: "close", hangRun: true, stepMs: 150 });

  await prompt(page, "keep going");
  await expect(stop(page)).toBeVisible();

  // The turn is only recorded server-side when its step ends, so the transcript
  // cannot supply this: the reply is here because the reconnected stream
  // delivered it.
  await expect(page.locator(".msg-assistant").last()).toContainText("Acknowledged.", {
    timeout: 20000,
  });
  // Still running as far as the server is concerned — so this was not a settle.
  await expect(stop(page)).toBeVisible();
  // And the resync that follows a reconnect didn't take the prompt with it.
  await expect(page.locator(".msg-user").last()).toContainText("keep going");
});

test("a stream that goes quiet without closing is replaced, and the turn recovered", async ({
  page,
  request,
}) => {
  // The socket stays open and nothing is ever written to it: no error, no close,
  // no events. Nothing in the connection can report this — only the watchdog
  // noticing that the run poll is getting answers while the stream is silent.
  await control(request, { cutStream: "mute", cutAfterDeltas: 0, hangRun: true, stepMs: 300 });

  await prompt(page, "anyone there");
  await expect(stop(page)).toBeVisible();

  // Not one event reaches the client for this turn, so this is the watchdog
  // reconnecting and resyncing the transcript across the gap.
  await expect(page.locator(".msg-assistant").last()).toContainText("Acknowledged.", {
    timeout: 30000,
  });
  await expect(stop(page)).toBeVisible();
  await expect(page.locator(".msg-user").last()).toContainText("anyone there");
});

test("stopping a run settles it, and keeps what the turn had already produced", async ({
  page,
  request,
}) => {
  await control(request, { stepMs: 150 });

  await prompt(page, "never mind");
  await expect(stop(page)).toBeVisible();
  // Interrupt partway through the thinking — before a word of the answer has
  // been streamed, though the server has already generated it.
  await expect(page.locator(".msg-assistant").last()).toContainText("Let me check", {
    timeout: 15000,
  });
  await stop(page).click();

  // Stop ends the turn, so it settles it like any other ending — the composer
  // comes back and stays back rather than waiting on a poll.
  await expect(send(page)).toBeVisible();
  await expect(stop(page)).toHaveCount(0);
  // And it reconciles: what the interrupted step produced is on screen without
  // a reload, which is what stopping used to need.
  await expect(page.locator(".msg-assistant").last()).toContainText("Acknowledged.");
  await expect(page.locator(".msg-user").last()).toContainText("never mind");
});
