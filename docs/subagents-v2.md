# Sub-agents in OpenCode V2 (Phase 0 verification)

> ⚠️ **NOT the deployment target.** This file documents a locally-installed
> `opencode-ai@next` build, which turned out to differ from the server this
> frontend actually ships against on every material point (event vocabulary,
> prompt body shape, existence of sub-agent dispatch). For the authoritative
> reference see **`docs/subagents-alfuat.md`**. Kept only as a record of how
> far builds can diverge — both report similar-looking version strings.

Tested against a live server on 2026-07-27.

| | |
|---|---|
| npm package | `opencode-ai@0.0.0-next-202606270058` (installed via `npm install -g opencode-ai@next`) |
| binary | `opencode2` — `opencode2 --version` prints `vlocal` (unhelpful); the real build id is in every `session.created` payload as `info.version` = `0.0.0-next-202606270058` |
| server | `opencode2 serve --hostname 127.0.0.1 --port 4096` |
| auth | `Authorization: Basic base64("opencode:<opencode2 service password>")` |
| model used for live runs | `opencode/big-pickle` (the only model the anonymous "public" OpenCode Zen key would serve) |

Every claim below is tagged **[observed]** (seen on the wire, in a live HTTP
response, or in the shipped binary's own bundled source) or **[spec]** (read
out of `/openapi.json` only).

---

## TL;DR — the headline finding

**Sub-agent dispatch is not implemented in this build.** There is no `task`
tool, no dispatch tool of any other name, and nothing in the server creates a
child session. Every scaffolding piece for child sessions exists — the DB
column, the index, the API field, the TUI's parent→child filter — but nothing
populates it.

The re-implementation plan's premise ("a `task` tool dispatches a sub-agent
into a child session whose `parentID` points at the parent") is the *right
model of where this is going*, but it cannot be built against this build
because no child session can be produced.

---

## 1. Dispatch tool

**❌ There is no dispatch tool in this build.** **[observed]**

Three independent confirmations:

1. **Live model report.** Prompted `build` to "use the task tool", the
   assistant replied that no such tool exists and enumerated its toolset:
   `apply_patch, bash, edit, glob, grep, question, read, skill, todowrite,
   webfetch, websearch, write`. **[observed]**

2. **The binary's own tool registry.** The bundled server source inside
   `opencode2.exe` has exactly twelve `register({[X]: tH.make({...})})` call
   sites. Resolving the minified keys gives exactly the twelve tools the model
   named — `read, bash, todowrite, edit, write, skill, glob, grep, webfetch,
   apply_patch, websearch, question`. No `task`. **[observed]**

3. **No `/api/tool` route.** `GET /api/tool` is not in `/openapi.json` and does
   not exist. There is no endpoint that enumerates tool schemas at all. **[spec]**

### What *looks* like a dispatch mechanism but isn't

| Thing | Where | Verdict |
|---|---|---|
| `task` as a permission key | Config docs string inside the binary: "Known permission keys: `read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop, skill`" | **[observed]** Vestigial. A permission key for a tool that is never registered. |
| `task` in the TUI's tool renderer | `new Set(["bash","glob","read","grep","webfetch","websearch","write","edit","task","apply_patch","todowrite","question","skill"])` — the TUI's tool-part renderer switch | **[observed]** The TUI can *render* a task part it will never receive. Carried over from V1. |
| `SubtaskPart` schema | `components.schemas.SubtaskPart` = `{id, sessionID, messageID, type:"subtask", prompt, description, agent, model?, command?}` | **[spec]** A **V1 legacy** part shape. It is not reachable from `Session.Message` (the V2 message union) — only from the old `Part` union, which the V2 pipeline never emits. Note it has **no `callID` and no child `sessionID`**. |
| `AgentPart` schema | `{id, sessionID, messageID, type:"agent", name, source?}` | **[spec]** Same story — V1 legacy. |
| `PromptInput.agents` | `agents?: Prompt.AgentAttachment[]`, `AgentAttachment = {name, source?}` | **[observed]** This is the `@agent` **mention annotation**, not a dispatch. See below. |

### The `@agent` mention path — tested, does not dispatch

`POST /api/session/{id}/prompt` with
`{"prompt":{"text":"@explore list the markdown files under docs/","agents":[{"name":"explore","source":{"start":0,"end":8,"text":"@explore"}}]}}`
returns 200 and then: **[observed]**

- `session.next.step.started` reports `agent: "build"` — **no agent switch**;
- the `build` agent ran `glob` itself;
- **no** `session.created` event fired;
- `GET /api/session` still shows zero sessions with a `parentID`.

The binary confirms why: `prompt.agents` is stored verbatim on the user message
and forwarded to the LLM as `metadata.agents` on the user turn. Nothing reads
it to spawn anything. **[observed]**

The only other reference to subagent mentions is a config-schema annotation:
`hidden` — *"Hide this subagent from the @ autocomplete menu (default: false,
only applies to mode: subagent)"* — i.e. the `@` menu is a client-side
affordance for *mentioning* a subagent, and in this build that mention is inert.
**[observed]**

---

## 2. Child-session linkage

Nothing produced a child session, so this is answered from schema + the shipped
TUI's own code. Ranked by evidence:

### (b) `session.created` — **strongest, and the one to build on** — [spec, structurally confirmed]

`V2Event.session.created.data` = `{sessionID, info: Session}` and
`Session.parentID` is an optional `^ses` string. **[spec]**

So when a child *is* created, the global `/api/event` stream will announce it
with the full child record including `parentID`, at creation time, no polling.
`session.created` on the global stream **is observed to fire for every session**
— I saw one per `POST /api/session`, carrying the complete `Session` record
(`id, slug, projectID, directory, path, cost, tokens, title, agent, version,
time`; `parentID` simply absent for root sessions). **[observed]**

**But it carries no `callID`.** `session.created` tells you *child → parent*.
It does not tell you *child → which tool call*.

### (a) the tool part carries it — **❌ no such field** — [spec]

Neither V2 tool shape has anywhere to put a child session id:

- `Session.Message.Assistant.Tool` = `{type:"tool", id, name, provider?, state, time}` — `state` is one of `Pending/Running/Completed/Error`, and **none of the four V2 tool states has a `metadata` field at all**. `Completed` = `{status, input, attachments?, content, outputPaths?, structured, result?}`. **[spec, and confirmed against a live `glob` call: state keys were exactly `status, input, content, outputPaths, structured`]** **[observed]**
- The V1 `ToolPart` *does* have `metadata`, and `ToolStateRunning/Completed/Error` have `metadata` — so `state.metadata.sessionID` is a plausible *future* carrier, and is where V1 put it. But V1 parts are not emitted by this pipeline. **[spec]**

### (c) after-the-fact via `GET /api/session` filtered on `parentID` — **works, and is what the shipped TUI does** — [observed]

The TUI's own code:

```js
q.session.list().filter((n) => n.parentID === U.sessionID && q.session.status(n.id) === "running").length
```

and the session picker excludes children with
`U.data.session.filter((s) => s.parentID === undefined)`. **[observed]**

The DB backs this: the `session` table has a `parent_id text` column and an
index `parent_idx ON session (parent_id)`. **[observed]**

Caveats for the frontend:

- **`GET /api/session` has no `parentID` query parameter.** Query params are
  `workspace, limit, order, search, directory, project, subpath, cursor`.
  Filtering is client-side. **[spec + observed]**
- **`POST /api/session` has no `parentID` in its body** either
  (`{id?, agent?, model?, location?}`), so a frontend cannot create a child
  session itself. **[spec + observed]**
- Default page size is the newest 50 sessions — a busy parent's children could
  fall off the first page.

**Fields available to disambiguate concurrent dispatches** (from `SessionV2.Info`
/ `Session`): `time.created` (ms epoch, and session ids are time-sortable —
`SessionID.descending` exists in the binary), `agent` (the subagent's id, e.g.
`explore`), `title`, `model`, `slug` (a random `adjective-noun`, e.g.
`witty-otter` — **not** derived from anything, useless for matching). **[observed]**

There is **no timestamp, no ordinal, and no tool reference** that would let you
match two simultaneous dispatches of the *same* agent to their two `callID`s.
With concurrent same-agent dispatches, (c) is ambiguous by construction.

### Verdict

If/when dispatch lands, key the registry off `session.created` + `parentID`
(option b) with `GET /api/session` as backfill (option c), and treat
`callID → childSessionID` as **not obtainable** until the server grows a field
for it. Do not design the UI so that a card is *anchored to a specific tool
part*; anchor it to the child session.

---

## 3. Child event routing

**Child events would carry only their own `sessionID`. No parent reference.** **[spec]**

Every `session.next.*` event's `data` starts `{timestamp, sessionID, ...}`.
None of the 33 `session.next.*` schemas has a `parentID`, `rootID`, `originID`,
or any other upward pointer. The envelope
(`{id, type, data, metadata?, durable?, location?}`) doesn't either —
`location` is a `Location.Ref` (`{directory, workspaceID?}`), shared by parent
and child. `durable.aggregateID` is the **child's own** session id. **[spec + observed]**

**A frontend cannot identify a child event standalone.** It must hold a
`sessionID → parentID` map populated from `session.created` / `GET /api/session`
and join against it. Events for a child that arrive before its `session.created`
is processed would be unattributable — order matters.

> ⚠️ Today `opencode.js#handleServerEvent` early-returns on
> `eventSessionId !== opencodeStore.activeSessionId`. That filter drops child
> events wholesale and is the first thing Phase 1 has to change.

---

## 4. Child lifecycle vocabulary

**[spec]** — unverifiable live, since no child was created.

There is nothing session-kind-specific anywhere in the event schemas: the same
`session.next.*` union is emitted for whatever `sessionID` is running. A child
session should therefore emit the **identical, full vocabulary**, not a subset.

The vocabulary as it actually exists (see §8 — this is *not* what
`docs/opencode-api.md` says):

| Group | Events **[observed on the wire unless noted]** |
|---|---|
| session record | `session.created`, `session.updated` **[spec]**, `session.deleted` **[spec]** |
| turn intake | `session.next.prompt.admitted`, `session.next.prompted` |
| step | `session.next.step.started`, `session.next.step.ended`, `session.next.step.failed` |
| text | `session.next.text.started`, `.delta`, `.ended` |
| reasoning | `session.next.reasoning.started`, `.delta`, `.ended` **[spec]** |
| tool | `session.next.tool.input.started`, `.input.delta` **[spec]**, `.input.ended`, `.called`, `.progress` **[spec]**, `.success`, `.failed` **[spec]** |
| switches | `session.next.agent.switched` **[spec]**, `session.next.model.switched` |
| other | `session.next.synthetic`, `.context.updated`, `.moved`, `.shell.started/.ended`, `.retried`, `.compaction.started/.delta/.ended`, `.revert.staged/.cleared/.committed` **[all spec]** |

**❌ Do not exist, in the spec or on the wire:** `session.execution.started` /
`.completed` / `.succeeded` / `.failed`, `session.idle`, `session.usage.updated`,
`session.input.admitted`, `session.input.promoted`, `session.model.selected`,
`session.error`, `session.child.*`, `session.subtask.*`. **[spec + observed]**

**❌ Never fired in practice:** `message.updated`, `message.part.updated`,
`message.part.removed`, `message.removed`. These are in the spec (V1 legacy) but
across ~90 captured events not one was emitted. **[observed]**

**Turn boundaries**, therefore, are `session.next.prompt.admitted` (start) and
`session.next.step.ended` / `.step.failed` (end) — there is no explicit
"execution finished" or "idle" signal.

---

## 5. Usage accounting

**Parent and child would be accounted separately — and in this build, session-level totals are dead.** **[observed]**

Two findings:

1. **`SessionV2.Info.cost` and `.tokens` are never updated.** After a session
   ran several real turns (one assistant message reported
   `tokens: {input: 268, output: 46, reasoning: 46, cache: {read: 3840, write: 0}}`),
   `GET /api/session/{id}` still returned
   `"cost": 0, "tokens": {"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}`.
   The fields exist and are always zero. **[observed]**

2. **Real usage lives per-message and per-step, keyed by `sessionID`:**
   - `session.next.step.ended.data` = `{timestamp, sessionID, assistantMessageID, finish, cost, tokens, snapshot?, files?}` **[observed]**
   - `Session.Message.Assistant.cost` / `.tokens` in `GET /api/session/{id}/message` **[observed]**

   Both are scoped to the emitting session. A child's steps carry the child's
   `sessionID`; nothing rolls them up into the parent. **[spec]**

**Implication:** a "sub-agent tokens" UI line built by summing child
`step.ended.tokens` **would not double-count**, because the parent has no
aggregate to double-count against. Conversely, a "total for this conversation"
figure must sum parent + all descendants itself — the server will not.

---

## 6. Agent metadata (`GET /api/agent`)

Response: `{location: Location.Info, data: AgentV2.Info[]}`. **[observed]**

`AgentV2.Info` fields — required marked ●: **[spec, all confirmed live]**

| Field | Type | Notes |
|---|---|---|
| ● `id` | string | **The only name-ish field.** Address agents by this. |
| ● `mode` | `"subagent" \| "primary" \| "all"` | |
| ● `hidden` | boolean | For `subagent`, means "hide from the `@` menu" |
| ● `request` | `Provider.Request` | `{headers, body}` — e.g. `{"temperature":0.1}` |
| ● `permissions` | `PermissionV2.Ruleset` | array of `{action, resource, effect}` |
| `description` | string | The display/selection blurb. Present on all four visible agents. |
| `model` | `Model.Ref` | **Absent on every agent in a default install** — they inherit the session model |
| `system` | string | The full system prompt. Can be multi-KB; `build`/`plan` use a `{file:...}` reference instead |
| `color` | `Agent.Color` | `"secondary"\|"accent"\|"success"\|"warning"\|"error"\|"info"\|...` — **absent on all default agents** |
| `steps` | integer > 0 | Absent on all default agents |

**❌ There is no `name` field.** `docs/opencode-api.md`'s "Agents are addressed
by `id`, not `name`" gotcha is right, and the reason is that `name` does not
exist on the wire at all. For display, use `id` (and `description` as subtitle).

Live inventory on a default install: **[observed]**

| id | mode | hidden | description |
|---|---|---|---|
| `build` | primary | false | The default agent. Executes tools based on configured permissions. |
| `plan` | primary | false | Plan mode. Disallows all edit tools. |
| `general` | **subagent** | false | General-purpose agent for researching complex questions and executing multi-step tasks… |
| `explore` | **subagent** | false | Fast agent specialized for exploring codebases… |
| `compaction` | primary | **true** | (internal) |
| `title` | primary | **true** | (internal) |
| `summary` | primary | **true** | (internal) |

So there are exactly **two** user-facing subagents shipped, and **no way to
invoke either of them** in this build.

---

## 7. History / backfill of a child transcript

`GET /api/session/{childID}/message` will work — child sessions are ordinary
rows in the same table, and the endpoint takes any `^ses` id with no
parent/child distinction. **[spec]**

Response shape is `SessionMessagesResponse` = `{data: Session.Message[], cursor: {previous, next}}`,
newest-first, opaque base64 cursors. **[observed]**

**Compatibility with `normalizeRestMessage` (web/src/stores/opencode.js:725): confirmed compatible.** **[observed]**

Verified against a live `GET /api/session/{id}/message`:

| What the code expects | What the server sent |
|---|---|
| `m.type` ∈ `user`/`assistant` | ✅ `assistant`, `user` (plus `agent-switched`/`model-switched`/`synthetic`/`system`/`shell`/`compaction` in the union, all correctly skipped) |
| user: `{id, time.created, text, files}` | ✅ `keys=id,time,text,agents,type` — note `agents` is present and ignored (fine) |
| assistant: `{id, time.created, content[], tokens, cost, error}` | ✅ `keys=id,time,type,agent,model,content,snapshot,finish,cost,tokens` (or `…,finish,error` on a failed turn) |
| content item `{type:"tool", id, name, state}` | ✅ `{"type":"tool","id":"call_0d35a6d7adbd412098c8b000","name":"glob","state":{...}}` — `normalizeContentItem` maps `item.id → callID`, `item.name → tool` correctly |
| `state.content[]` → joined text for completed | ✅ completed state keys were `status, input, content, outputPaths, structured` |

Two things a child-transcript view will need on top of what's already handled:

- `m.agent` (present on every assistant message, e.g. `"build"`) is **dropped**
  by `normalizeRestMessage`. For a sub-agent card you want it.
- `m.finish` (`"error"`, etc.) is dropped too.

Also available, and better suited to a child card than polling messages:
**`GET /api/session/{sessionID}/event`** is a session-scoped SSE stream that
**replays the session's durable event log from `seq: 0`** and then goes live;
it takes an `after` cursor query param. Confirmed live — connecting to an
already-finished session immediately replayed `session.next.prompt.admitted`
(seq 1), `.prompted` (seq 2), … **[observed]** This is the cleanest primitive
for "open a child session's card and show its whole turn".

---

## 8. Discrepancies with `docs/opencode-api.md`

`docs/opencode-api.md` is not edited here, per Phase 0 scope. Verified against
the same build it claims (`0.0.0-next-202606270058`).

### 🔴 Its whole "SSE event catalog" section is wrong

Every `session.*` name it lists is a name this server never emits. **[observed + spec]**

| `docs/opencode-api.md` says | Actual |
|---|---|
| `session.execution.started` / `.completed` / `.failed` | ❌ do not exist |
| `session.idle` | ❌ does not exist |
| `session.model.selected` | ❌ — it's `session.next.model.switched` |
| `session.input.admitted` | ❌ — it's `session.next.prompt.admitted` |
| (not listed) | `session.next.*` — the entire 33-event turn vocabulary |
| `message.updated`, `message.part.updated`, `.removed` "wired" | in the spec, but **never emitted** in ~90 captured events |
| (not listed) | `session.created`, `session.updated`, `session.deleted`, `todo.updated`, `question.v2.replied`, `reference.updated` |

The same wrong names are hardcoded in `handleServerEvent`
(`web/src/stores/opencode.js:428-680`) — `session.execution.started`,
`session.step.started`, `session.text.delta`, `session.tool.called`,
`session.usage.updated`, `session.idle`, `session.error` — with no `.next.`
normalization anywhere. **The live-streaming path in the harness cannot be
receiving anything.** Out of Phase 0 scope to fix; flagged as almost certainly
the root cause of any "messages only appear after refresh" behaviour.

### 🟡 Smaller ones

| Item | Doc claim | Actual |
|---|---|---|
| `SessionV2.Info.location` | `Location.Info` | `Location.Ref` **[spec]** |
| `SessionV2.Info` required set | not stated | `id, projectID, cost, tokens, time, title, location` — `agent`, `model`, `parentID`, `subpath`, `revert` are all optional **[spec]** |
| `POST /api/session/{id}/wait` | "Not wired. Sync wait for completion" | exists but **stubbed**: 503 `{"_tag":"ServiceUnavailableError","message":"Session wait is not available yet","service":"session.wait"}` — same status as `compact` **[observed]** |
| `POST /api/session` body | `{id?, agent?, model?, location?}` | correct — but sending `location: {directory: "C:\\projects\\opencodeharness"}` (the value `/api/location` itself returns) **500s**. Omitting `location` works and defaults to the server's own directory. **[observed]** |
| path inventory | complete list given | missing `/experimental/project/{projectID}/copy` and `/experimental/project/{projectID}/copy/refresh` **[spec]** |
| `GET /api/agent` field list | implies a `name` | no `name` field exists **[spec + observed]** |
| forking | "Use `revert/*` instead" | the TUI agrees and says so out loud: *"Forking is not implemented for V2 sessions yet"* **[observed, from the binary]** |

### 🟢 Confirmed correct

- `/openapi.json` is the spec path; all routes under `/api/*`.
- `POST /api/session/{id}/prompt` **must** wrap under `prompt` — a flat
  `{"text":"…"}` returns 400 `Missing key at ["prompt"]`. **[observed]**
  (Note: the comment above `sendPrompt` in `web/src/stores/opencode.js:801`
  claims the opposite — "Body is a FLAT PromptInput … a wrapped `{prompt: {...}}`
  400s". That comment is backwards for this build.)
- `compact` returns 503. **[observed]**
- No `DELETE`/`PATCH` on `/api/session/{sessionID}` — only `get`. **[spec]**
- No `fork`, no `share`, no `command`, no `/api/vcs/*`. **[spec]**
- Auth is Basic and enforced despite `security: []` on every op. **[observed]**

---

## Implications for the frontend

**Phase 1 cannot be validated end-to-end on this build.** Any child-session
registry written now is speculative: no server-side path produces a child
session. Recommend either (a) building the registry defensively and shipping it
dark, or (b) deferring until an `opencode-ai@next` build lands that registers a
dispatch tool.

If Phase 1 proceeds, the registry in `web/src/stores/opencode.js` should key on:

1. **`sessionID` as the primary key — never `callID`.** There is no
   `callID → childSessionID` link anywhere in the API. Model a sub-agent card
   as "a child session", not "a tool part that has a session".

2. **`parentID`, sourced from two places:**
   - `session.created` on the global stream → `data.info.parentID` (live path);
   - `GET /api/session` → filter `s.parentID === activeSessionId` client-side
     (backfill path; there is no server-side `parentID` filter, and default page
     size is 50).

3. **A `sessionID → parentID` map consulted by the event handler**, because
   `session.next.*` events carry only the child's own `sessionID`. This
   requires **removing the `eventSessionId !== activeSessionId` early return at
   `web/src/stores/opencode.js:411-421`** and replacing it with a
   "belongs to active session *or* to one of its descendants" test.

4. **The correct event names** — `session.next.*`, not the `session.*` names
   currently in `handleServerEvent`. This is a prerequisite for everything, not
   just sub-agents.

5. **Turn state from `session.next.prompt.admitted` → `session.next.step.ended`
   / `.step.failed`.** There is no `session.idle` or `execution.succeeded` to
   close a card on.

6. **Usage from `session.next.step.ended.data.{cost,tokens}`, summed per
   session.** Do not read `SessionV2.Info.cost/tokens` — always zero. Parent
   totals do **not** include children, so a "sub-agent tokens" line is additive,
   not a subset.

7. **For backfilling a finished child's transcript**, prefer
   `GET /api/session/{childID}/event` (replays the durable log from seq 0, then
   goes live) over `GET /api/session/{childID}/message`. If you use the message
   endpoint, `normalizeRestMessage` already handles the shape — but capture
   `m.agent` and `m.finish`, which it currently drops.

8. **For the agent picker / card labels**: `AgentV2.Info.id` + `.description`.
   There is no `name`, and `model`/`color` are absent on stock agents.

---

## Artifacts

Raw captures from this session:

| File | What |
|---|---|
| `<scratchpad>/openapi.json` | the live spec (215 KB, 238 schemas, 51 paths) |
| `<scratchpad>/sse-tap.txt` | global `/api/event` tap, model-credential probing |
| `<scratchpad>/sse-subagent.txt` | global `/api/event` tap, ~90 events across the four sub-agent dispatch attempts |
| `<scratchpad>/agents.json` | live `GET /api/agent` |
| `<scratchpad>/models.json` | live `GET /api/model` |
| `<scratchpad>/messages.json` | live `GET /api/session/{id}/message` |
| `<scratchpad>/sessions.json` | live `GET /api/session` (proving zero children) |
| `<scratchpad>/bin-strings.txt` | `strings` of `opencode2.exe` (235k lines) — the tool registry, the TUI's `parentID` filters, and the DB schema were all read from here |

`<scratchpad>` = `C:\Users\crispy\AppData\Local\Temp\claude\C--projects-opencodeharness\27f9fdb1-601c-4277-b833-a51146b9dbe1\scratchpad`
