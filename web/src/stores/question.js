// Interactive Q&A store. A tool can stop mid-execution and ask the user one or
// more structured questions; the ask arrives as the `question.v2.asked` SSE
// event (see opencode.js#handleServerEvent) and queues here until answered.
// Mirrors stores/permission.js — same FIFO-queue shape, same dialog contract.
//
// Shapes below are verified against a live `opencode2 serve` `/openapi.json`
// (see docs/opencode-api.md § Questions). The two that matter:
//
//   QuestionV2.Request = {id: "que_...", sessionID, questions: Info[], tool?}
//   QuestionV2.Info    = {question, header, options: [{label, description}],
//                         multiple?, custom?}
//   QuestionV2.Reply   = {answers: string[][]}
//
// Note what options do NOT have: an id. An answer identifies its choice by
// the option's `label` verbatim, and `answers` is positional — one entry per
// question in `questions` order, each entry a list of chosen labels (a list
// because `multiple` questions accept several).
import { reactive } from "vue";
import { apiBase, authHeaders } from "./ssh.js";

export const questionStore = reactive({
  queue: [], // [{ id, sessionID, questions, tool, receivedAt, error, busy }]
});

// `QuestionV2.Option` requires both keys, but a missing description is far
// less bad than a dropped option, so only a labelless option is discarded —
// it would be an unanswerable button.
function normalizeOption(opt) {
  if (typeof opt === "string") return opt ? { label: opt, description: "" } : null;
  if (!opt || typeof opt !== "object") return null;
  const label = typeof opt.label === "string" ? opt.label : "";
  if (!label) return null;
  return {
    label,
    description: typeof opt.description === "string" ? opt.description : "",
  };
}

function normalizeQuestion(info) {
  if (!info || typeof info !== "object") return null;
  const options = Array.isArray(info.options)
    ? info.options.map(normalizeOption).filter(Boolean)
    : [];
  return {
    question: info.question || "",
    header: info.header || "",
    options,
    multiple: info.multiple === true,
    // With no options there is nothing to click, so free text is the only way
    // to answer at all — treat that as custom regardless of the flag, rather
    // than rendering a dead end.
    custom: info.custom === true || options.length === 0,
  };
}

function normalizeRequest(data) {
  const questions = Array.isArray(data.questions)
    ? data.questions.map(normalizeQuestion).filter(Boolean)
    : [];
  if (!data.id || !questions.length) return null;
  return {
    id: data.id,
    sessionID: data.sessionID || "",
    questions,
    tool: data.tool || null,
    receivedAt: Date.now(),
    error: null,
    busy: false,
  };
}

function enqueue(data) {
  if (!data || !data.id) return;
  if (questionStore.queue.some((q) => q.id === data.id)) return;
  const entry = normalizeRequest(data);
  if (entry) questionStore.queue.push(entry);
}

function dequeue(id) {
  if (!id) return;
  questionStore.queue = questionStore.queue.filter((q) => q.id !== id);
}

// Only `question.v2.asked` enqueues. `.replied` and `.rejected` are the
// outbound confirmations and clear the entry — the same asked/settled pairing
// permission.js uses. Both settle events key the request as `requestID`
// (`id` on those payloads is the event's own evt_ id, not the question's).
export function handleQuestionEvent(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};

  if (type === "question.v2.asked") {
    enqueue(data);
    return;
  }

  if (type === "question.v2.replied" || type === "question.v2.rejected") {
    dequeue(data.requestID);
  }
}

// GET /api/question/request — pending asks for the current location, across
// sessions. A dropped `asked` event (SSE reconnect, a tab opened after the
// ask) otherwise leaves the agent blocked forever on a question the UI never
// shows, so reconcile against the server rather than trusting the stream.
export async function loadPendingQuestions() {
  try {
    const res = await fetch(`${apiBase()}/question/request`, { headers: authHeaders() });
    if (!res.ok) return;
    const payload = await res.json();
    const pending = Array.isArray(payload) ? payload : payload?.data || [];
    for (const request of pending) enqueue(request);
  } catch {
    // Best-effort reconciliation — the SSE stream is the primary path.
  }
}

// POST /api/session/{sessionID}/question/{requestID}/reply
// `answers` is positional: answers[i] holds the labels chosen for
// questions[i]. Returns 204 on success.
export async function reply(requestID, answers) {
  await send(requestID, "reply", { answers });
}

// POST /api/session/{sessionID}/question/{requestID}/reject — the user
// declining to answer, which lets the tool proceed (or fail) on its own.
// Takes no body.
export async function reject(requestID) {
  await send(requestID, "reject", null);
}

async function send(requestID, path, body) {
  const entry = questionStore.queue.find((q) => q.id === requestID);
  if (!entry || entry.busy) return;
  entry.busy = true;
  entry.error = null;
  try {
    const init = { method: "POST", headers: { ...authHeaders() } };
    if (body) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(
      `${apiBase()}/session/${entry.sessionID}/question/${requestID}/${path}`,
      init
    );
    if (res.ok) {
      dequeue(requestID);
      return;
    }
    // The server explains a rejected answer precisely (which key, which
    // question); surface that instead of a bare status.
    entry.error = await errorMessage(res, path);
  } catch (err) {
    entry.error = err.message || `Failed to ${path} question`;
  } finally {
    entry.busy = false;
  }
}

async function errorMessage(res, path) {
  const fallback = `Failed to ${path} (${res.status})`;
  try {
    const payload = await res.json();
    return payload?.message ? `${fallback}: ${payload.message}` : fallback;
  } catch {
    return fallback;
  }
}
