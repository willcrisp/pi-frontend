// Session-level actions that aren't prompting: revert, interrupt, agent switch,
// compact.
import { opencodeStore } from "./state.js";
import { apiPost, errorMessage } from "../../lib/api.js";
import { refreshActiveMessages } from "./messages.js";
import { runMayHaveEnded } from "./run.js";

// --- Revert ------------------------------------------------------------------
// V2 has no session fork, and `revert/*` is the closest thing to "go back to
// before message X": stage a revert to preview it, then commit to keep it or
// clear to abandon it. The staged state lives on the session record's `revert`
// field server-side, mirrored here so the banner can offer the two exits.
//
// ⚠️ The stage BODY is unverified — the spec names the route but the request
// schema was never captured. It is built in one place for that reason.
export async function stageRevert(messageID) {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID || !messageID) return;
  if (await postRevert(sessionID, "stage", { messageID })) {
    opencodeStore.revertStaged = { messageID };
    await refreshActiveMessages();
  }
}

// Make the staged revert permanent.
export async function commitRevert() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  if (await postRevert(sessionID, "commit", {})) {
    opencodeStore.revertStaged = null;
    await refreshActiveMessages();
  }
}

// Abandon the staged revert and restore the full transcript.
export async function clearRevert() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  if (await postRevert(sessionID, "clear", {})) {
    opencodeStore.revertStaged = null;
    await refreshActiveMessages();
  }
}

async function postRevert(sessionID, action, body) {
  try {
    const res = await apiPost(`/session/${sessionID}/revert/${action}`, body);
    if (res.ok) return true;
    opencodeStore.error = await errorMessage(res, `Revert ${action} failed (${res.status})`);
    return false;
  } catch (err) {
    opencodeStore.error = err.message || `Revert ${action} failed`;
    return false;
  }
}

// --- Other session actions ---------------------------------------------------

// Interrupt the running agent loop (POST /api/session/:id/interrupt).
//
// Deliberately does NOT clear the streaming flag itself. An accepted interrupt is
// a *candidate* for "the run is over" in exactly the sense run.js means it, and
// run.js is the only thing that decides — by asking GET /session/active.
//
// This used to assert the run had stopped in a `finally`, without ever reading
// `res.ok`. Two bugs in one: a rejected interrupt looked identical to an accepted
// one, and the optimistic flag turned the stop square into a send arrow while the
// agent was still working, until the next poll flipped it back — the
// stop→send→stop flap run.js was written to eliminate.
//
// `interrupting` covers the honest gap in between: the server has taken the
// request but the loop hasn't drained yet, so the button says "stopping…" rather
// than either lying or looking dead. run.js#settleRun clears it.
export async function abortSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID || opencodeStore.interrupting) return;

  opencodeStore.interrupting = true;
  try {
    const res = await apiPost(`/session/${sessionID}/interrupt`);
    if (!res.ok) {
      opencodeStore.interrupting = false;
      opencodeStore.error = await errorMessage(res, `Couldn't stop the agent (${res.status})`);
      return;
    }
  } catch (err) {
    opencodeStore.interrupting = false;
    opencodeStore.error = err.message || "Couldn't stop the agent";
    return;
  }
  runMayHaveEnded(sessionID);
}

// Select the agent. Switched on the active session via POST /api/session/:id/agent { agent }.
//
// The picker is rolled back when the server refuses: showing an agent the session
// isn't actually using is worse than not switching, because the next prompt then
// runs as something other than what the composer says.
export async function setAgent(agentName) {
  const previous = opencodeStore.selectedAgent;
  opencodeStore.selectedAgent = agentName;
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID || !agentName) return;

  try {
    const res = await apiPost(`/session/${sessionID}/agent`, { agent: agentName });
    if (res.ok) return;
    opencodeStore.error = await errorMessage(res, `Couldn't switch to ${agentName} (${res.status})`);
  } catch (err) {
    opencodeStore.error = err.message || `Couldn't switch to ${agentName}`;
  }
  opencodeStore.selectedAgent = previous;
}

// Compact the active session's context (POST /api/session/:id/compact),
// then reconcile the transcript with server truth. In current builds this
// may return 503 "Session compact is not available yet" — surface that as
// an error banner rather than swallowing it silently.
export async function compactSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;
  try {
    const res = await apiPost(`/session/${sessionID}/compact`);
    if (res.ok) {
      await refreshActiveMessages();
      return;
    }
    opencodeStore.error = await errorMessage(res, `Compact failed (${res.status})`);
  } catch (err) {
    opencodeStore.error = err.message || "Failed to compact session";
  }
}
