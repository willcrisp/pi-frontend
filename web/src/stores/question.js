// Interactive Q&A store. A tool can stop mid-execution and ask the user a
// structured question; it arrives as the `question.v2.asked` SSE event (see
// opencode.js#handleServerEvent) and queues here until answered. Mirrors
// stores/permission.js — same FIFO-queue shape, same dialog contract.
//
// ⚠️ The reply BODY shape is the one thing here that has not been verified
// against a live server (no question was ever captured on the wire). The
// request/event side is tolerant of several plausible field spellings; the
// outbound body is deliberately built in one place — `replyBody` — so that
// correcting it against `/openapi.json` is a one-line change.
import { reactive } from "vue";
import { apiBase, authHeaders } from "./ssh.js";

export const questionStore = reactive({
  queue: [], // [{ id, sessionID, question, options, metadata, receivedAt, error, busy }]
});

// Options are `QuestionV2.Option`. Normalized to {id, label, description} so
// the dialog renders one shape regardless of which spelling the server uses;
// a bare string option is treated as its own id and label.
function normalizeOption(opt, index) {
  if (typeof opt === "string") return { id: opt, label: opt, description: "" };
  if (!opt || typeof opt !== "object") return null;
  const id = opt.id ?? opt.value ?? opt.key ?? String(index);
  return {
    id: String(id),
    label: opt.label || opt.title || opt.name || String(id),
    description: opt.description || opt.detail || "",
  };
}

// Only `question.v2.asked` enqueues. `question.v2.rejected` (and a
// `.replied`, should this build emit one) is the outbound confirmation and
// clears the entry — the same asked/settled pairing permission.js uses.
export function handleQuestionEvent(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};

  if (type === "question.v2.asked") {
    if (!data.id || questionStore.queue.some((q) => q.id === data.id)) return;
    const options = Array.isArray(data.options) ? data.options : [];
    questionStore.queue.push({
      id: data.id,
      sessionID: data.sessionID || "",
      question: data.question || data.text || data.prompt || "",
      options: options.map(normalizeOption).filter(Boolean),
      metadata: data.metadata || {},
      receivedAt: Date.now(),
      error: null,
      busy: false,
    });
    return;
  }

  if (type === "question.v2.rejected" || type === "question.v2.replied") {
    const id = data.requestID || data.id;
    questionStore.queue = questionStore.queue.filter((q) => q.id !== id);
  }
}

// The single place the outbound answer shape is decided — see the warning at
// the top of this file.
function replyBody(option, text) {
  const body = {};
  if (option) body.option = option;
  if (text) body.text = text;
  return body;
}

function dequeue(id) {
  questionStore.queue = questionStore.queue.filter((q) => q.id !== id);
}

// POST /api/session/{sessionID}/question/{requestID}/reply
export async function reply(questionID, option, text) {
  await send(questionID, "reply", replyBody(option, text));
}

// POST /api/session/{sessionID}/question/{requestID}/reject — the user
// declining to answer, which lets the tool proceed (or fail) on its own.
export async function reject(questionID) {
  await send(questionID, "reject", {});
}

async function send(questionID, path, body) {
  const entry = questionStore.queue.find((q) => q.id === questionID);
  if (!entry || entry.busy) return;
  entry.busy = true;
  entry.error = null;
  try {
    const res = await fetch(
      `${apiBase()}/session/${entry.sessionID}/question/${questionID}/${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      }
    );
    if (res.ok) {
      dequeue(questionID);
      return;
    }
    entry.error = `Failed to ${path} (${res.status})`;
  } catch (err) {
    entry.error = err.message || `Failed to ${path} question`;
  } finally {
    entry.busy = false;
  }
}
