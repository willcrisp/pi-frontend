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
  appendLocalUserMessage(promptText, attachments);
  opencodeStore.isStreaming = true;
  opencodeStore.interrupting = false;
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
    opencodeStore.error = err.message;
    console.error("Error sending prompt to opencode:", err);
  }
}
