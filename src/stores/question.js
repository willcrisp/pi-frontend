// Interactive Q&A store. A tool can stop mid-execution and ask the user one or
// more structured questions.
//
// Two SSE event families exist across builds:
//   1. `question.v2.*` / `question.*` — the documented shape (question.js handles)
//   2. `form.*` — the current build (0.0.0-next-16573) emits forms, with
//      metadata.kind === "question" marking ones the question tool created.
//
// The queue normalises both into one shape so QuestionDialog and QuestionPart
// have one source of truth:
//
//   entry = {id, sessionID, questions: [{question, header, options,
//            multiple, custom}], tool: {messageID, callID}?, receivedAt, error,
//            busy}
//
// Reply and cancel route to the right endpoint depending on how the entry
// entered the queue (question vs form).
import { reactive } from "vue";
import { apiGet, apiPost, unwrap } from "../lib/api.js";

export const questionStore = reactive({
  queue: [], // [{ id, sessionID, questions, tool, _kind, receivedAt, error, busy }]
});

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
    _kind: "question",
    receivedAt: Date.now(),
    error: null,
    busy: false,
  };
}

// --- Form → question normalisation ------------------------------------------

// Form.Event.Created payload = {form: Form.Info}
// Form.Info = {id, sessionID, title, metadata?, fields: Field[]}
// Form.Field = {key, title?, description?, type, options?, custom?}
//   - "string" type with options renders as single-select
//   - "multiselect" renders as checkbox group
//   - type without options still gets a free-text input (custom)

function formFieldToQuestion(f) {
  if (!f || typeof f !== "object") return null;
  const type = f.type === "multiselect" ? "multiselect" : "string";
  const opts = Array.isArray(f.options)
    ? f.options.map((o) =>
        normalizeOption({
          label: o.label || o.value || "",
          description: o.description || "",
        })
      ).filter(Boolean)
    : [];
  return {
    question: f.description || "",
    header: f.title || "",
    options: opts,
    multiple: type === "multiselect",
    custom: f.custom === true || opts.length === 0,
  };
}

function fromFormCreated(data) {
  const form = (data && data.form) || data;
  if (!form || form.metadata?.kind !== "question" || !Array.isArray(form.fields))
    return null;
  const questions = form.fields.map(formFieldToQuestion).filter(Boolean);
  if (!form.id || !questions.length) return null;
  return {
    id: form.id,
    sessionID: form.sessionID || "",
    questions,
    tool: (form.metadata && form.metadata.tool) || null,
    _kind: "form",
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

function enqueueForm(data) {
  if (!data) return;
  const entry = fromFormCreated(data);
  if (entry) {
    if (questionStore.queue.some((q) => q.id === entry.id)) return;
    questionStore.queue.push(entry);
  }
}

function dequeue(id) {
  if (!id) return;
  questionStore.queue = questionStore.queue.filter((q) => q.id !== id);
}

// question.* / question.v2.* — older/alternate builds.
export function handleQuestionEvent(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};

  const name = (type || "").replace(/^question\.v2\./, "question.");

  if (name === "question.asked") {
    enqueue(data);
    return;
  }

  if (name === "question.replied" || name === "question.rejected") {
    dequeue(data.requestID);
  }
}

// form.* — the current build. Only metadata.kind === "question" forms
// are tracked here; other forms (MCP elicitation etc.) don't block a run.
export function handleFormEvent(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};

  if (type === "form.created") {
    enqueueForm(data);
    return;
  }

  // form.replied / form.cancelled carry {id} (not requestID)
  if (type === "form.replied" || type === "form.cancelled") {
    dequeue(data.id);
  }
}

// GET /api/form/request — pending forms across sessions. Filters to
// metadata.kind === "question" so only question-tool forms enter the queue.
// Also hits /question/request for builds that still use the question routes.
export async function loadPendingQuestions() {
  try {
    const res = await apiGet("/form/request");
    if (res.ok) {
      for (const form of unwrap(await res.json())) enqueueForm({ form });
    }
  } catch {
    // Best-effort — the SSE stream is the primary path.
  }

  // Fallback for older builds with question.* routes.
  try {
    const qres = await apiGet("/question/request");
    if (qres.ok) {
      for (const request of unwrap(await qres.json())) enqueue(request);
    }
  } catch {
    // Best-effort.
  }
}

// POST /api/session/{sessionID}/question/{requestID}/reply
// `answers` is positional: answers[i] holds the labels chosen for
// questions[i]. Returns 204 on success.
export async function reply(requestID, answers) {
  const entry = questionStore.queue.find((q) => q.id === requestID);
  if (!entry || entry.busy) return;

  if (entry._kind === "form") {
    await replyForm(entry, answers);
    return;
  }
  await sendQuestion(requestID, entry, "reply", { answers });
}

// POST /api/session/{sessionID}/question/{requestID}/reject
export async function reject(requestID) {
  const entry = questionStore.queue.find((q) => q.id === requestID);
  if (!entry || entry.busy) return;

  if (entry._kind === "form") {
    await cancelForm(entry);
    return;
  }
  await sendQuestion(requestID, entry, "reject", null);
}

async function replyForm(entry, answers) {
  entry.busy = true;
  entry.error = null;
  // Form.Reply = {answer: {q0: string, q1: string[]}}
  const fields = entry.questions;
  const answer = {};
  for (let i = 0; i < fields.length; i++) {
    const key = `q${i}`;
    const val = answers[i] || [];
    answer[key] = fields[i].multiple ? val : (val[0] || "");
  }
  try {
    const res = await apiPost(
      `/session/${entry.sessionID}/form/${entry.id}/reply`,
      { answer }
    );
    if (res.ok) {
      dequeue(entry.id);
      return;
    }
    entry.error = await errorMessage(res, "reply");
  } catch (err) {
    entry.error = err.message || "Failed to reply to form";
  } finally {
    entry.busy = false;
  }
}

async function cancelForm(entry) {
  entry.busy = true;
  entry.error = null;
  try {
    const res = await apiPost(
      `/session/${entry.sessionID}/form/${entry.id}/cancel`,
      undefined
    );
    if (res.ok) {
      dequeue(entry.id);
      return;
    }
    entry.error = await errorMessage(res, "cancel");
  } catch (err) {
    entry.error = err.message || "Failed to cancel form";
  } finally {
    entry.busy = false;
  }
}

async function sendQuestion(requestID, entry, path, body) {
  entry.busy = true;
  entry.error = null;
  try {
    const res = await apiPost(
      `/session/${entry.sessionID}/question/${requestID}/${path}`,
      body ?? undefined
    );
    if (res.ok) {
      dequeue(requestID);
      return;
    }
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