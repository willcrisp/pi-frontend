// Session handover: compacting a chat into a written spec another chat can be
// started from.
//
// `/handover` asks the agent that did the work to write the document — not the
// client. A client-side summary can only concatenate message text (that is all
// fork.js does, and it is the right thing there), which is a transcript dump,
// not a handover: it cannot say which of two approaches was abandoned and why,
// which files matter, or what is left. The agent holding the context can, so the
// command sends it a prompt and captures its reply.
//
// The reply stays in the transcript as an ordinary assistant message — it is
// worth reading — and is ALSO filed here under an 8-character id, rendered as a
// chip under that message (HandoverChip.vue). Clicking the chip opens
// HandoverDialog.vue, which is where extra instructions get added before the new
// chat is created and seeded.
//
// Lives above stores/opencode/ for the same reason fork.js does: it drives
// session creation (projects.js), which itself imports the opencode facade.
import { reactive, watch } from "vue";
import { opencodeStore } from "./opencode/state.js";
import { sendPrompt } from "./opencode/prompt.js";
import { activityRecord } from "./opencode/activity.js";
import { fetchSessionMessages } from "./opencode/messages.js";
import { activeSessionDirectory, projectsStore, startNewChat } from "./projects.js";
import { readArray, writeJSON } from "../lib/storage.js";

const HANDOVERS_KEY = "oc.handovers";

// Records are small (a document each) but unbounded in principle, and they are
// only ever read back by clicking a chip in a transcript. Keep the newest few.
const MAX_RECORDS = 30;

// A document longer than this is not a handover any more, and it has to fit in
// the seed prompt of the chat it opens. Truncation is marked so the next agent
// knows it is reading a fragment.
const MAX_BODY_CHARS = 60000;

export const handoverStore = reactive({
  // [{ id, sessionID, messageID, title, directory, body, createdAt }],
  // newest first.
  records: loadRecords(),
  // Session a handover is currently being written for, or "". The composer and
  // the slash command both read it so a second /handover can't stack.
  generatingFor: "",
  // Id of the record whose dialog is open, or "".
  openId: "",
  // Set while startHandoverChat is creating + seeding the new session.
  starting: false,
});

function loadRecords() {
  return readArray(HANDOVERS_KEY).filter((r) => r && r.id && r.body);
}

function persist() {
  writeJSON(HANDOVERS_KEY, handoverStore.records.slice(0, MAX_RECORDS));
}

// --- The prompt --------------------------------------------------------------

// Deliberately long. The failure mode of a short brief here is a short document
// — "we refactored the store and some tests fail" — which is worth nothing to a
// chat that has never seen this conversation. Every section below exists because
// its absence is what makes a handover useless: no file paths, no record of what
// was rejected, no distinction between "verified" and "assumed", no acceptance
// criteria on the work that is left.
//
// The first line doubles as a marker: the brief is a real user turn and the
// server echoes it back in the transcript, where 3KB of instructions to the
// agent is noise rather than something the user wants to re-read. MessageView
// collapses a turn that starts with it to a one-line marker instead.
const REQUEST_MARKER = "Write a HANDOVER DOCUMENT for this session.";

export function isHandoverRequest(text) {
  return typeof text === "string" && text.trimStart().startsWith(REQUEST_MARKER);
}

const HANDOVER_PROMPT = `${REQUEST_MARKER}

Stop any other work and produce it now. It is being sent to an agent that will
continue this work in a brand-new chat with NO access to this conversation, this
transcript, or your memory of it. This document is the only thing it gets.

Write it from what you already know here. Re-read a file only where you would
otherwise have to guess at something specific (an exact path, a symbol name, a
signature) — do not re-explore the whole task.

Style: a specification, not a summary. Verbose, concrete and specific. Prefer
exact detail over brevity everywhere they conflict — an over-long handover
costs a few seconds of reading, a vague one costs the next agent the whole
investigation again. Name real file paths, real function/component/variable
names, real commands, real error text. Quote the important code or config
inline. Never write "as discussed", "the usual place", "some tests", "a few
files" or "the relevant function" — the reader cannot resolve any of those.
Where you are not certain of something, say so explicitly and say how to check.

Use this structure, as GitHub-flavoured markdown, keeping the headings:

# Handover: <short descriptive title>

## 1. Summary
Two to four sentences: what this session set out to do and where it got to.

## 2. Objective
The original request in full, plus any refinements or changes of direction that
came later, and who asked for them. Include the acceptance criteria the work is
actually being judged against.

## 3. Current state
What exists right now, in enough detail that the reader can predict what they
will find on disk. For every file created or modified: its full path, what it
now does, and what changed in it. Mention anything left half-finished, and any
uncommitted or committed work (branch name, commit messages if known).

## 4. Implementation details
The heart of the document. For each piece of work: how it is built, the data
shapes and function signatures involved, the control flow, how the parts connect,
and the invariants that must hold. Include code excerpts where the exact text
matters. Someone should be able to extend this work from this section without
re-reading everything from scratch.

## 5. Decisions and rejected alternatives
Each significant decision, why it was made, and what was considered and rejected
— with the reason. This is what stops the next agent redoing settled arguments
or reintroducing an approach that was already found not to work.

## 6. Constraints, conventions and traps
Project conventions that must be followed, environmental constraints, APIs that
behave unexpectedly, ordering requirements, anything that has already bitten
this session or nearly did. Be blunt about the sharp edges.

## 7. Verification status
What was actually run (exact commands) and what it said. Separate clearly:
verified by running it / believed correct but unverified / known broken. If
nothing was run, say that plainly.

## 8. Remaining work
An ordered, numbered list of everything still to do. For each item: what to do,
where (paths), why it is needed, and how to tell when it is done. Put the
recommended next action first and mark it as such.

## 9. Risks and open questions
Anything unresolved, anything that could invalidate the plan, and every question
that needs the user's answer before the work can be finished.

## 10. Environment
Working directory, branch, relevant services or servers and how to start them,
and the commands for building, running and testing this project.

Reply with the document and nothing else — no preamble before it, no offer of
help after it. Begin your reply with the "# Handover:" line.`;

// The document out of the agent's reply. It is asked for the document alone, so
// the usual case is the whole text; slicing to the heading covers a build or a
// model that prefixes a line of chat anyway.
export function extractDocument(text) {
  const body = (text || "").trim();
  const at = body.search(/^#\s+Handover\b/im);
  const doc = at > 0 ? body.slice(at) : body;
  return doc.length > MAX_BODY_CHARS
    ? `${doc.slice(0, MAX_BODY_CHARS)}\n\n…[handover truncated at ${MAX_BODY_CHARS} characters]`
    : doc;
}

// Short, human-quotable, and unique against what we have stored. Not a real
// UUID — 8 hex characters of one, which is what fits on a chip and what someone
// can read out loud.
function mintId() {
  const taken = new Set(handoverStore.records.map((r) => r.id));
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = randomHex8();
    if (!taken.has(id)) return id;
  }
  return `${Date.now().toString(16).slice(-8)}`;
}

function randomHex8() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, "").slice(0, 8);
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}

// --- Generating --------------------------------------------------------------

// Resolve when the run in `sessionID` stops.
//
// Watches the per-session activity flag rather than `opencodeStore.isStreaming`,
// because that one belongs to whichever session is on screen: navigating away
// mid-handover would otherwise settle it against another chat's state. `sync`
// flush matters — a run that fails inside sendPrompt goes true then false within
// one tick, and a batched watcher compares the ends of that and sees no change.
function whenRunSettles(sessionID) {
  const record = activityRecord(sessionID);
  return new Promise((resolve) => {
    let started = record.running;
    const stop = watch(
      () => record.running,
      (running) => {
        if (running) {
          started = true;
          return;
        }
        if (!started) return;
        stop();
        resolve();
      },
      { flush: "sync" }
    );
  });
}

function sessionTitle(sessionID) {
  return projectsStore.sessions.find((s) => s.id === sessionID)?.title || "";
}

// Ask the active session's agent for a handover, then file its answer.
// Returns the new record, or null if nothing usable came back.
export async function requestHandover() {
  const sessionID = opencodeStore.activeSessionId;
  if (!sessionID || handoverStore.generatingFor) return null;
  if (opencodeStore.isStreaming) {
    opencodeStore.error = "Wait for the current turn to finish before asking for a handover.";
    return null;
  }

  const directory = activeSessionDirectory();
  const title = sessionTitle(sessionID);
  handoverStore.generatingFor = sessionID;

  // Installed before the prompt goes out: sendPrompt marks the session running
  // synchronously, and a run short enough to settle inside the POST's await
  // would otherwise resolve against a watcher that isn't there yet.
  const settled = whenRunSettles(sessionID);

  try {
    await sendPrompt(HANDOVER_PROMPT, []);
    await settled;

    // Read back from the server rather than from opencodeStore.messages: the
    // user may have switched chats while it was being written, in which case
    // the store holds a different session's transcript.
    const messages = (await fetchSessionMessages(sessionID)) || [];
    const reply = [...messages].reverse().find((m) => m.role === "assistant" && (m.text || "").trim());
    const body = extractDocument(reply?.text);
    if (!body) {
      opencodeStore.error = "The handover came back empty — nothing was written.";
      return null;
    }

    const record = {
      id: mintId(),
      sessionID,
      messageID: reply.id,
      title,
      directory,
      body,
      createdAt: Date.now(),
    };
    handoverStore.records = [record, ...handoverStore.records].slice(0, MAX_RECORDS);
    persist();
    return record;
  } catch (err) {
    opencodeStore.error = err.message || "Failed to write the handover";
    return null;
  } finally {
    handoverStore.generatingFor = "";
  }
}

// --- Reading back ------------------------------------------------------------

// The record whose document is the given message, or null. Drives the chip in
// MessageView — messageID is the server's own id, so a chip survives a reload
// and a transcript refresh.
export function handoverForMessage(messageID) {
  if (!messageID) return null;
  return handoverStore.records.find((r) => r.messageID === messageID) || null;
}

export function handoverById(id) {
  return handoverStore.records.find((r) => r.id === id) || null;
}

export function openHandover(id) {
  handoverStore.openId = id || "";
}

export function closeHandover() {
  handoverStore.openId = "";
}

// --- Starting the next chat --------------------------------------------------

// The seed prompt for the new chat: the document, framed so the agent knows what
// it is reading and does not mistake a plan for something already done, plus
// whatever the user typed into the dialog.
export function handoverSeedText(record, extra) {
  const notes = (extra || "").trim();
  const from = [
    record.title ? `the session "${record.title}"` : "an earlier session",
    record.directory ? ` in ${record.directory}` : "",
  ].join("");

  return [
    `You are picking up work in progress. This is handover ${record.id}, written at`,
    `the end of ${from} by the agent that did the work.`,
    "",
    "It is the authoritative account of what has already happened — but it is a",
    "written record, not the code itself. Read the files it names before changing",
    "them, and check anything it flags as unverified rather than trusting it.",
    "",
    `--- handover ${record.id} ---`,
    record.body,
    `--- end handover ${record.id} ---`,
    "",
    notes
      ? `Instructions for this session:\n\n${notes}`
      : "Pick up from the 'Remaining work' section, starting with the item marked as" +
        " the recommended next action. Before you change anything, tell me in a few" +
        " lines what you understand the current state to be and what you are about to do.",
  ].join("\n");
}

// Create a new chat in the same project and send it the seeded prompt. Mirrors
// forkFromMessage: the new session has to be active with its (empty) transcript
// loaded before the prompt lands, or the load overwrites the optimistic message.
export async function startHandoverChat(extra) {
  const record = handoverById(handoverStore.openId);
  if (!record || handoverStore.starting) return;

  const text = handoverSeedText(record, extra);
  handoverStore.starting = true;
  try {
    await startNewChat(record.directory || undefined);
    await sendPrompt(text, []);
    closeHandover();
  } catch (err) {
    opencodeStore.error = err.message || "Failed to start the handover chat";
  } finally {
    handoverStore.starting = false;
  }
}
