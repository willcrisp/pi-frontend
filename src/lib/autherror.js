// Recognising "the model provider rejected our credentials" in the text a
// failed turn comes back with, so the error banner can say what happened
// instead of passing the provider's bare complaint through.
//
// The case this exists for is a GitHub Copilot token expiring. OpenCode
// exchanges the GitHub OAuth token for a Copilot API token that lives about
// half an hour, and caches it; a long-running `opencode2 serve` keeps
// presenting the cached one, so prompts start failing with "invalid auth
// header" once the server has been up longer than that — while prompting from
// a fresh `opencode` process, which performs the exchange again, still works.
// That difference is the whole symptom, and it looks like a frontend bug when
// the banner only says "invalid auth header".
//
// None of it is fixable from here. The integration/credential surface in
// docs/opencode-api.md has no route that forces a re-exchange, and the server
// reads its config once at startup (§ "Config is read once at startup"). What
// the frontend can do is name the cause and offer the retry, which is what
// succeeds once the server holds a fresh token.
//
// Dependency-free on purpose, like the other lib/ helpers: it is a pure string
// classifier, which is also what makes it testable without a browser.

// Phrases a provider uses to say the credential was no good. Kept narrow — a
// false positive puts a confident, wrong explanation under a real error.
const CREDENTIAL_REJECTED = [
  /invalid\s+(authorization|authentication|auth)\s+header/i,
  /\bunauthorized\b/i,
  /\bbad\s+credentials\b/i,
  /authentication\s+(failed|error)/i,
  /\b(api\s*keys?|tokens?|credentials?)\b[^.]{0,40}\b(invalid|expired|revoked|rejected|missing)\b/i,
  /\b(invalid|expired|revoked|missing)\b[^.]{0,40}\b(api\s*keys?|tokens?|credentials?)\b/i,
  /\b401\b/,
];

const COPILOT_HINT =
  "GitHub Copilot's API token is short-lived (~30 min) and a long-running " +
  "opencode2 serve can keep using an expired one — which is why the same " +
  "prompt works from a fresh opencode process. Retry; if it fails again, " +
  "restart the OpenCode server so it exchanges a new token.";

const GENERIC_HINT =
  "The model provider rejected OpenCode's credentials — usually an expired " +
  "token the server is still caching. Retry; if it fails again, reconnect " +
  "that provider or restart the OpenCode server.";

function mentionsCopilot(message, providerID) {
  return /copilot/i.test(`${providerID || ""} ${message || ""}`);
}

// The explanation to print under `message`, or null when it isn't a credential
// failure. `providerID` is the provider the turn was running on (from the
// selected model) and only picks which explanation applies.
export function providerAuthHint(message, providerID) {
  const text = String(message || "");
  if (!text) return null;
  if (!CREDENTIAL_REJECTED.some((re) => re.test(text))) return null;
  return mentionsCopilot(text, providerID) ? COPILOT_HINT : GENERIC_HINT;
}
