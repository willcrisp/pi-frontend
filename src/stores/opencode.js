// The OpenCode V2 client — a direct HTTP REST + SSE client for the opencode2
// "HttpApi" surface (routes under /api, list responses wrapped in `{ data }`),
// reached through the dev proxy. See docs/opencode-api.md for the endpoint
// inventory and the confirmed shapes.
//
// This file is a facade: it re-exports the public surface so components keep a
// single import path (`stores/opencode.js`) no matter how the internals move.
// Import from here in components; import the specific module inside
// stores/opencode/ when writing another store module.
//
// ── The modules, bottom of the dependency graph first ────────────────────────
//
//   state.js      The reactive store itself. Imports no sibling, so anything
//                 may read and write it without a cycle.
//   transport.js  POST /session/:id/prompt — delivery modes and the flat-vs-
//                 wrapped body divergence between server builds.
//   children.js   Linking a `subagent` tool call to the child session it
//                 dispatched, across the three routes that link can arrive by.
//   models.js     Model + reasoning-effort selection and its two layers of
//                 persistence.
//   context.js    Token and context accounting (local estimate vs server truth).
//   steer.js      Prompts admitted into a run already in flight.
//   activity.js   Per-session running/unread state — the sidebar's status dot.
//   drafts.js     Per-session composer drafts; `state.draft` is the active
//                 one, this keeps the rest and persists them.
//   messages.js   Transcript loading, REST->view normalization, sub-agent
//                 backfill.
//   run.js        When a turn is over: which events might mean it, and the
//                 GET /session/active reconciliation that decides.
//   prompt.js     Sending a prompt that starts a turn.
//   catalog.js    Models, agents, commands and skills lists.
//   session.js    Revert, interrupt, agent switch, compact.
//   events.js     The SSE reducer — a table of one handler per event type.
//   stream.js     The SSE subscription and initOpenCode().
//
// Dependencies run strictly downward in that order; there are no cycles, and
// adding one would be a design error rather than a detail. The practical rule:
// if two modules need each other, the shared part belongs lower down.

export { opencodeStore, SUBAGENT_TOOL } from "./opencode/state.js";
export { childForCall, isSubagentPart } from "./opencode/children.js";
export {
  restoreSessionModel,
  selectedModelRef,
  setModel,
  setThinkingLevel,
} from "./opencode/models.js";
export { refreshSessionContext } from "./opencode/context.js";
export { sessionStatus } from "./opencode/activity.js";
export { pendingSteersFor, sendSteer } from "./opencode/steer.js";
export {
  connectToSession,
  loadSessionTranscript,
  refreshActiveMessages,
} from "./opencode/messages.js";
export { sendPrompt } from "./opencode/prompt.js";
export {
  loadAgents,
  loadCatalogs,
  loadCommands,
  loadModels,
  loadSkills,
  runCommand,
} from "./opencode/catalog.js";
export {
  abortSession,
  clearRevert,
  commitRevert,
  compactSession,
  setAgent,
  stageRevert,
} from "./opencode/session.js";
export { handleServerEvent } from "./opencode/events.js";
export { initOpenCode } from "./opencode/stream.js";
