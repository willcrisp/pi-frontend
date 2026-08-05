// Forking a chat at one of its prompts.
//
// V2 has no fork endpoint (see docs/opencode-api.md) and no way to copy history
// into a new session, so a fork is reconstructed client-side: create a session
// in the same project, then send one prompt carrying the conversation up to the
// branch point as context, followed by the prompt being forked from. The new
// chat therefore *continues* from that point rather than sharing state with the
// original — the two run independently from there, which is the whole point.
//
// Lives above stores/opencode/ rather than inside it: it drives session
// creation (projects.js), which itself imports the opencode facade.
import { reactive } from "vue";
import { opencodeStore, sendPrompt } from "./opencode.js";
import { activeSessionDirectory, startNewChat } from "./projects.js";

export const forkStore = reactive({
  // Index into opencodeStore.messages currently being forked, or -1. Drives the
  // rail button's disabled/busy state; a fork is two round trips plus a prompt,
  // so a double click would otherwise create two sessions.
  forkingIndex: -1,
});

// Per-message and whole-transcript caps on the context we replay. A long chat
// would otherwise produce a first prompt bigger than the context window it is
// meant to seed; the oldest turns are dropped first, with a note saying so.
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_CHARS = 40000;

function clip(text) {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated]` : text;
}

// The prior turns as a plain-text transcript, newest kept when the cap bites.
// Only message text is replayed — tool calls, diffs and reasoning are the
// original run's working, not context the forked chat can act on.
function transcript(messages) {
  const blocks = [];
  let total = 0;
  let dropped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = (msg.text || "").trim();
    if (!text) continue;
    const block = `${msg.role === "user" ? "User" : "Assistant"}: ${clip(text)}`;
    if (total + block.length > MAX_TOTAL_CHARS) {
      dropped = i + 1;
      break;
    }
    blocks.unshift(block);
    total += block.length;
  }
  if (dropped) blocks.unshift(`[…${dropped} earlier message(s) omitted…]`);
  return blocks.join("\n\n");
}

function forkPromptText(priorMessages, promptText) {
  const context = transcript(priorMessages);
  if (!context) return promptText;
  return [
    "This chat is a fork of an earlier one. Here is the conversation up to the",
    "point it was forked at, for context only — the work it describes has",
    "already happened.",
    "",
    "--- forked conversation ---",
    context,
    "--- end forked conversation ---",
    "",
    "Continue from there. My message:",
    "",
    promptText,
  ].join("\n");
}

// Fork at `index` into opencodeStore.messages: everything above it becomes
// context, and the message at `index` (a user prompt) is re-sent as the new
// chat's first request.
export async function forkFromMessage(index) {
  if (forkStore.forkingIndex !== -1) return;
  const messages = opencodeStore.messages;
  const target = messages[index];
  if (!target || target.role !== "user") return;
  const promptText = (target.text || "").trim();
  if (!promptText) return;

  // Read before the new session takes over as active.
  const directory = activeSessionDirectory();
  const text = forkPromptText(messages.slice(0, index), promptText);

  forkStore.forkingIndex = index;
  try {
    // Resolves once the new session is active and its (empty) transcript has
    // loaded — sending before that lands would have the load overwrite the
    // optimistic user message.
    await startNewChat(directory);
    await sendPrompt(text, []);
  } catch (err) {
    opencodeStore.error = err.message || "Failed to fork chat";
  } finally {
    forkStore.forkingIndex = -1;
  }
}
