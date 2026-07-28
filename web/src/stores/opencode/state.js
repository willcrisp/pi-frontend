// The OpenCode V2 client's shared state.
//
// Deliberately the bottom of the dependency graph: this module imports nothing
// from its siblings, so any of them can read and write the store without a
// cycle. Behaviour lives in the siblings, listed in ../opencode.js.
import { reactive } from "vue";

export const opencodeStore = reactive({
  connected: false,
  activeSessionId: null,
  activeSession: null,
  messages: [],
  isStreaming: false,
  availableModels: [], // [{ providerID, modelID, label, contextLimit, variants }]
  selectedModel: null, // { providerID, modelID }
  thinkingLevel: "", // selected model variant name ("" only while no variant-capable model is selected)
  availableAgents: [],
  // Agents with `mode: "subagent"` (general, explore, plus anything defined in
  // .opencode/agent). Kept out of availableAgents so they never show in the
  // composer's picker — they're dispatched by the `subagent` tool, not selected
  // as the session agent — but retained here as the live roster the sub-agent
  // manager (subagents.js) joins its definition files against. `hidden` ones are
  // included: for a subagent that flag only hides it from the `@` menu, and
  // dropping them here would make them unmanageable.
  subagentRoster: [],
  selectedAgent: "build",
  draft: "",
  error: null,
  // A staged (previewed, not yet committed) revert: { messageID } or null.
  // See session.js#stageRevert/commitRevert/clearRevert.
  revertStaged: null,
  sessionStats: {
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    // `percent` is derived from message tokens against the model's catalog
    // limit until GET /session/{id}/context answers, after which the server's
    // own accounting wins — `fromServer` records which one you're looking at
    // so the local estimate never silently overwrites server truth.
    contextUsage: { percent: 0, used: null, limit: null, fromServer: false },
  },
  commands: [],
  skills: [],
  // Sub-agent dispatches. A `subagent` tool call spawns a CHILD SESSION whose
  // turn streams over this same /api/event connection under its own sessionID.
  // childSessions is keyed by that child sessionID; callChildIndex maps the
  // dispatching tool call to it so the view layer can look up by callID.
  // See children.js and docs/subagents-alfuat.md.
  childSessions: {},
  callChildIndex: {},
  // Prompts admitted into a run that was already going (steer/queue delivery)
  // and not yet picked up by the agent. Entries are
  //   { id, sessionID, text, delivery, messageID, status, at }
  // and exist only for the session in view — see steer.js. The transcript
  // can't show them: the server keeps an admitted input out of the message
  // list until it promotes it, so this array is the only handle the UI has on
  // "sent, waiting to be read".
  pendingSteers: [],
  // Per-session agent activity, keyed by session id:
  //   { running: bool, unread: bool, updatedAt: ms }
  // The event stream carries EVERY session, not just the one in view, so this
  // is maintained for all of them and outlives navigating away — that is the
  // whole point of the sidebar dot (amber pulse = working, green = it finished
  // while you were looking at another chat). See activity.js.
  sessionActivity: {},
});

// Name of the tool whose calls dispatch a sub-agent (verified live on the
// ALF-UAT build; `functions.subagent` in the model's own tool list).
export const SUBAGENT_TOOL = "subagent";
