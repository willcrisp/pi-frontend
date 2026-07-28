// Steering: sending a prompt into a run that is already going, for the agent to
// read at its next turn ("steer") or after the run finishes ("queue"). See
// transport.js for what the server does with each delivery mode.
//
// Deliberately unlike sendPrompt, this does NOT push an optimistic user message:
// an admitted input is not part of the transcript until the server promotes it,
// and dropping one into the middle of a streaming assistant message would put
// it in the wrong place and then have it move when refreshActiveMessages
// reconciles at the end of the run. It lives in `pendingSteers` until then,
// which is what the composer's steer button reports.
import { opencodeStore } from "./state.js";
import { postPrompt, promptWithFiles } from "./transport.js";
import { errorMessage } from "../../lib/api.js";

let steerSeq = 0;

// Returns true if the server admitted it.
export async function sendSteer(text, files, delivery = "steer") {
  const promptText = (text || "").trim();
  const attachments = Array.isArray(files) ? files : [];
  const sessionID = opencodeStore.activeSessionId;
  if ((!promptText && !attachments.length) || !sessionID) return false;

  const entry = {
    id: `steer-${Date.now()}-${steerSeq++}`,
    sessionID,
    text: promptText,
    delivery,
    messageID: null,
    status: "sending",
    at: Date.now(),
  };
  opencodeStore.pendingSteers.push(entry);

  try {
    const res = await postPrompt(sessionID, promptWithFiles(promptText, attachments), { delivery });
    if (!res.ok) {
      throw new Error(
        await errorMessage(
          res,
          res.status === 400
            ? "This server build doesn't accept a delivery mode — steering unavailable"
            : `Steer failed (${res.status})`
        )
      );
    }
    const payload = await res.json().catch(() => null);
    const admitted = (payload && payload.data) || payload || {};
    entry.messageID = admitted.id || null;
    entry.delivery = admitted.delivery || delivery;
    entry.status = "waiting";
    return true;
  } catch (err) {
    dropSteer(entry.id);
    opencodeStore.error = err.message;
    console.error("Error steering session:", err);
    return false;
  }
}

function dropSteer(id) {
  const at = opencodeStore.pendingSteers.findIndex((s) => s.id === id);
  if (at >= 0) opencodeStore.pendingSteers.splice(at, 1);
}

// Pending steers for one session, oldest first — what the steer button names in
// its tooltip.
export function pendingSteersFor(sessionID) {
  return opencodeStore.pendingSteers.filter((s) => s.sessionID === sessionID);
}

// The agent has taken an input: it's a real message now, so stop tracking it.
// Matched on messageID where the event carries one; a build that doesn't report
// it settles for the oldest entry of that session, which is the one promotion
// order makes correct.
export function resolveSteer(sessionID, messageID) {
  const list = opencodeStore.pendingSteers;
  const at = messageID
    ? list.findIndex((s) => s.messageID === messageID)
    : list.findIndex((s) => s.sessionID === sessionID);
  if (at >= 0) list.splice(at, 1);
}

// Everything admitted for a session that has stopped running has either been
// promoted or died with the run — nothing is still waiting to be read.
export function clearSteers(sessionID) {
  opencodeStore.pendingSteers = opencodeStore.pendingSteers.filter((s) => s.sessionID !== sessionID);
}
