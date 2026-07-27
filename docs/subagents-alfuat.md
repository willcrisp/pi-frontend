# Sub-agents on the ALF-UAT server (the real deployment target)

Verified **2026-07-27** against the `opencode2 serve` running on the
`williamcrisp/ALF-UAT` Coder workspace, reached through a local tunnel on
port 5000 (`/api/health` → `{"healthy":true,"version":"0.0.0-next-16281","pid":30075}`).

Every claim below is marked **[observed]** (seen on the wire or in a live
response) or **[spec]** (read from `/openapi.json` only). Raw artifacts are in
the scratchpad as `alfuat-openapi.json`, `alfuat-sse.txt`,
`alfuat-parent-msgs.json`, `alfuat-child-msgs.json`.

> ⚠️ **This build is NOT the one described in `docs/subagents-v2.md`.** A
> locally-installed `opencode-ai@next` (version `0.0.0-next-202606270058`)
> differs on *every* point that matters: it emits `session.next.*` event
> names, requires a wrapped `{prompt:{text}}` body, and has no sub-agent
> dispatch at all. Do not mix findings between the two. This file describes
> the deployment target; `subagents-v2.md` describes a build we do not ship
> against.

## Verdict

**Phases 1–4 of the sub-agent UI can proceed.** The dispatch tool exists, the
child session is directly addressable from the tool call, and the child's turn
streams live over the connection the frontend already holds open.

## The dispatch tool

`subagent` **[observed]** — confirmed both by asking the live model to
enumerate its tools (`functions.subagent`, alongside glob/grep/patch/question/
read/shell/skill/webfetch/websearch/execute) and by dispatching one.

❌ There is no `/api/tool` route (404) **[observed]**. The tool list is only
discoverable by asking the model or reading the binary.

Input shape **[observed]**:

```json
{ "agent": "explore", "description": "List workspace files",
  "prompt": "List the files in /tmp/octest …", "background": false }
```

| Field | Notes |
|---|---|
| `agent` | an `id` from `GET /api/agent` with `mode: "subagent"` |
| `description` | short label; becomes the child session's `title` |
| `prompt` | the task text |
| `background` | boolean; unverified what `true` changes |

Available sub-agents **[observed]**: `general`, `explore` (`GET /api/agent`,
`mode === "subagent"`, `hidden === false`). Fields present: `id`, `name`,
`description`, `mode`, `hidden`, `permissions`, `request`; `explore` also has
`system`. ❌ No `model` or `color` field on either.

## Linking a tool call to its child session

**This is the key finding, and it is the best case: linkage is direct.** Two
independent sources, one for live rendering and one for history.

**Live [observed]** — `session.tool.progress` fires on the *parent* session and
carries both the `callID` and the child `sessionID`. Note the doubled nesting:

```json
{"type":"session.tool.progress","data":{
  "sessionID":"<parent>","assistantMessageID":"msg_…",
  "callID":"call_iUxzZmqzMJf3WhDn737D9z9R",
  "metadata":{"metadata":{"sessionID":"<child>","status":"running"}}}}
```

**History [observed]** — the stored tool part carries it on `state.metadata`:

```json
{"type":"tool","id":"call_iUxzZmqzMJf3WhDn737D9z9R","name":"subagent",
 "state":{"status":"completed","input":{…},"content":[{"type":"text","text":"…"}],
          "metadata":{"sessionID":"<child>","status":"completed"}}}
```

So no `parentID` scan of `GET /api/session` is needed, and concurrent
dispatches are never ambiguous — each call carries its own child id.

## Child sessions

`GET /api/session/{childID}` **[observed]**:

```json
{"id":"ses_05c1a08f…","parentID":"ses_05c1a7f1…","agent":"explore",
 "model":{"id":"gpt-5.6-luna-fast","providerID":"openai","variant":"default"},
 "title":"List workspace files","location":{"directory":"/tmp/octest"},
 "cost":0,"tokens":{"input":1791,"output":61,"reasoning":15,
                    "cache":{"read":0,"write":0}}}
```

| Field | Use |
|---|---|
| `parentID` | present and correct |
| `agent` / `model` | card header — model includes `variant` |
| `title` | mirrors the dispatch `description` |
| `tokens` | populated and real |
| `cost` | **always 0** — not populated on either parent or child. A cost column would render `$0.00`; show tokens instead |

## Child event routing

Child events stream over the **same global `GET /api/event`** connection under
the child's own `sessionID` **[observed]** — 65 events referenced the child in
one dispatch. They use the full ordinary vocabulary, not a subset:

`session.created` → `session.input.admitted` → `session.execution.started` →
`session.step.started` → `session.reasoning.*` / `session.text.*` /
`session.tool.*` → `session.step.ended` → `session.usage.updated` →
`session.execution.succeeded`

The child's `session.created` carries `data.info.parentID` **[observed]**, so a
child event is identifiable standalone — but in practice the frontend will
already know the child id from `session.tool.progress`, which arrives first.

Envelope also carries `durable:{aggregateID,seq,version}` where `aggregateID`
is the session id **[observed]** — useful for ordering/replay.

## Usage accounting

Parent and child are accounted **separately** **[observed]**:
`session.usage.updated` fired 4× for the parent and 2× for the child, each with
its own `sessionID`. Parent totals do **not** include child tokens, so a
"sub-agent tokens" line in the UI is additive and does not double-count.

## Backfill

`GET /api/session/{childID}/message` **[observed]** returns the child's full
transcript in exactly the parent's shape — `type: "user" | "assistant"`, with
assistant `content[]` items of `text` / `reasoning` / `tool`, plus `agent`,
`model`, `tokens`, `cost`, `finish`. **`normalizeRestMessage` in
`web/src/stores/opencode.js` handles it unchanged.** Newest-first, same as the
parent, so the existing ascending sort applies.

## Discrepancies with `docs/opencode-api.md`

| Claim there | Reality here **[observed]** |
|---|---|
| `POST …/prompt` body "**must wrap under `prompt`**"; flat `{text}` 400s | **Backwards.** The spec has `required: ["text"]` at the top level with `additionalProperties: false`. Flat is correct — which is what `sendPrompt` already sends. The wrapped form is what the *local* build wants |
| SSE catalog | Correct for this server. `session.execution.*`, `session.idle`, `session.text.delta`, `message.part.updated`, `session.usage.updated` all exist |
| `POST /api/session` `location` param | Works here (`{"location":{"directory":"/tmp/octest"}}` → 200). It 500s on the local build |

`handleServerEvent` and `sendPrompt` are therefore **correct against this
server**. The "harness is fundamentally broken" conclusion in
`subagents-v2.md` applies only to the local build.

## Implications for the frontend

1. **The one real blocker** is the session filter at
   `web/src/stores/opencode.js:412` — it early-returns any event whose
   `sessionID` differs from the active session, which drops every child event.
   Replace with a router: active → `opencodeStore.messages`; known child →
   that child's own message list.
2. **Registry key is the child `sessionID`**, with a `callID → sessionID` index
   populated from `session.tool.progress` (live) and from
   `state.metadata.sessionID` when normalizing history.
3. **The part mutators must take a target message list.**
   `findOrCreateMessage` / `assistantMessageFor` / `upsertPart` /
   `appendPartText` / `recomputeText` currently hardcode
   `opencodeStore.messages`. Once parameterised, child rendering falls out of
   the existing event cases for free — the child speaks the same vocabulary.
4. **Detection** for `MessageView`: `part.tool === "subagent"`. Prefer that over
   sniffing the result shape.
5. **Backfill** on `connectToSession`: for each stored `subagent` tool part,
   read `state.metadata.sessionID` and fetch that child's messages. No
   `parentID` scan required.
6. Show **tokens, not cost** (cost is always 0).

## Caveats

- `background: true` on the dispatch input was not exercised; behaviour unknown.
- Parallel/concurrent dispatches were not exercised. Linkage is per-`callID` so
  it should hold, but the UI's handling of several in-flight children is
  untested.
- A failing sub-agent was not captured, so the error-path shape
  (`state.status === "error"`, `metadata.status`) is **[spec]**-level only.
- Sessions whose `location.directory` is large (e.g. `/home/coder`) stall
  before `session.execution.started` while opencode git-snapshots the work
  tree. Not a frontend bug; it cost ~30 min of debugging here.
