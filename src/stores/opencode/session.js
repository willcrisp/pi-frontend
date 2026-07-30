// Session-level actions that aren't prompting: revert, interrupt, agent switch,
// compact.
import { opencodeStore } from "./state.js";
import { apiPost, errorMessage } from "../../lib/api.js";
import { refreshActiveMessages } from "./messages.js";
import { settleWhenIdle } from "./run.js";

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

// Interrupt active running execution (POST /api/session/:id/interrupt).
//
// Settles the run rather than just lowering the flags: stopping ends the turn,
// so it owes the same reconciliation the natural end does — the transcript
// refreshed against the server, and any admitted-but-unread steer dropped.
// Without it, stop left whatever the stream had last delivered on screen, and
// the answer only appeared on a page reload.
export async function abortSession() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID) return;

  // Immediately, so the composer answers the click rather than the round-trip;
  // the settle below does it again along with the rest of the state.
  opencodeStore.isStreaming = false;
  try {
    await apiPost(`/session/${sessionID}/interrupt`);
  } catch (err) {
    console.error("Failed to interrupt session:", err);
  } finally {
    // Once the server has actually stopped, not the moment it accepts the
    // interrupt — see settleWhenIdle. Merged rather than replaced, because an
    // interrupted step may never be flushed at all, and then the partial answer
    // on screen is the only copy of it.
    await settleWhenIdle(sessionID, { merge: true });
  }
}

// Select the agent. Switched on the active session via POST /api/session/:id/agent { agent }.
export async function setAgent(agentName) {
  opencodeStore.selectedAgent = agentName;
  const sessionID = opencodeStore.activeSessionId;
  if (sessionID && agentName) {
    try {
      await apiPost(`/session/${sessionID}/agent`, { agent: agentName });
    } catch (e) {
      console.warn("Failed to switch session agent:", e);
    }
  }
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
