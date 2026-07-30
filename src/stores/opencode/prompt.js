// Sending a prompt to start (or extend) a turn.
//
// The optimistic user message is the point of difference from steer.js: a
// prompt sent to an idle session becomes a real message immediately, so it is
// appended locally and reconciled against the server when the run ends. A steer
// cannot be, because the server withholds an admitted input from the message
// list until it promotes it.
import { opencodeStore } from "./state.js";
import { postPrompt, promptWithFiles } from "./transport.js";
import { appendLocalUserMessage } from "./messages.js";
import { markRunning, markStopped } from "./activity.js";
import { reportRunError } from "./errors.js";
import { errorMessage } from "../../lib/api.js";

// `files` are composer attachments (paste/drop/picker), each `{ filename, mime,
// url }` where `url` is a `data:<mime>;base64,...` URL — see
// transport.js#promptWithFiles for why they can't be sent as-is.
export async function sendPrompt(text, files) {
  const attachments = Array.isArray(files) ? files : [];
  const promptText = (text || "").trim();
  if ((!promptText && !attachments.length) || !opencodeStore.activeSessionId) return;
  const sessionID = opencodeStore.activeSessionId;

  opencodeStore.draft = "";
  // Kept for retryLastPrompt: a turn that dies on a provider's expired token
  // fails through no fault of the prompt, and retyping it is pure friction.
  opencodeStore.lastPrompt = { sessionID, text: promptText, attachments };
  appendLocalUserMessage(promptText, attachments);
  opencodeStore.isStreaming = true;
  markRunning(sessionID);

  try {
    const res = await postPrompt(sessionID, promptWithFiles(promptText, attachments));
    if (!res.ok) {
      throw new Error(await errorMessage(res, `Failed to send prompt (${res.status})`));
    }
    // Do NOT append assistant text here — the SSE stream drives assistant rendering.
  } catch (err) {
    opencodeStore.isStreaming = false;
    markStopped(sessionID);
    reportRunError(err.message);
    console.error("Error sending prompt to opencode:", err);
  }
}

// Re-send the last prompt. Offered by the error banner when a turn failed on
// something a second attempt can clear — a provider token the server has since
// renewed being the case it was built for.
//
// The user message from the failed attempt stays in the transcript: it really
// was sent, and the server kept it. This adds a second one, which is what
// sending it again honestly looks like.
export async function retryLastPrompt() {
  const last = opencodeStore.lastPrompt;
  if (!last || opencodeStore.isStreaming) return;
  if (last.sessionID !== opencodeStore.activeSessionId) return;
  opencodeStore.error = null;
  opencodeStore.errorHint = null;
  await sendPrompt(last.text, last.attachments);
}
