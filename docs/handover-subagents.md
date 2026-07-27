# Handover: inline sub-agent rendering

In-flight feature work. Phases 0–1 are **done and verified against a live
server**; Phases 2–5 remain. This doc is the pickup point.

Companion docs: `docs/subagents-alfuat.md` (the API ground truth — read it
first), `docs/subagents-v2.md` (a *different* build, explicitly not the
target), `docs/handover.md` (general project status).

## What this feature is

A `subagent` tool call used to render as a rich inline card — per-agent
status, model, task, live token counts, an activity log of the sub-agent's
own tool calls, and its final output. That existed in the pi era
(commits `612d4b0`, `f8d6d9e`) and was orphaned by the `pivot` commit
`32ffe2f`, which only did a mechanical import rename.

**Most of the presentation layer survived and is still in the tree**:
`web/src/components/chat/SubagentView.vue` (~250 lines, complete) and all
~50 `.subagent-*` rules in `web/src/style.css` (lines ~1695–1970,
including `.subagent-badge`). This is a re-plumbing job, not a rebuild.

## ⚠️ Read this before touching anything

**Two OpenCode V2 builds exist and they are incompatible.** They report
similar-looking version strings, so version does not discriminate them.
Always tap `/api/event` against the server you are actually pointed at.

| | **ALF-UAT (the target)** | A local `npm i -g opencode-ai@next` |
|---|---|---|
| version | `0.0.0-next-16281` | `0.0.0-next-202606270058` |
| SSE names | `session.execution.*`, `session.idle`, `session.text.delta` | `session.next.*` |
| prompt body | flat `{text}` | wrapped `{prompt:{text}}` |
| sub-agents | ✅ `subagent` tool | ❌ none at all |

The harness implements the **left** column and is correct as written.
Note `docs/opencode-api.md:57` claims the prompt body must be wrapped —
that is wrong for the target server. Don't "fix" `sendPrompt` to match it.

## Reaching the live server

The target is `opencode2 serve` running on the `williamcrisp/ALF-UAT`
Coder workspace, tunnelled to **local port 5000** (not 4096 — a local
build may be squatting there).

```sh
CODER="C:/Users/crispy/AppData/Local/Microsoft/WinGet/Packages/Coder.Coder_Microsoft.Winget.Source_8wekyb3d8bbwe/coder.exe"
CFG="C:/Users/crispy/AppData/Roaming/Code/User/globalStorage/coder.coder-remote/coder-corp.codex.fortescue.com"
"$CODER" --global-config "$CFG" ssh ALF-UAT -- "opencode2 service password"
```

Use that config dir — the default `~/AppData/Roaming/coderv2` profile is
signed out. Auth is `Authorization: Basic base64("opencode:<password>")`.
The frontend reaches it via the dev proxy at `/api/5000/api` (set the port
in the ConnectDialog).

**Gotcha that cost 30 minutes**: a session whose `location.directory` is
large (e.g. `/home/coder`) stalls after `session.input.admitted` and never
reaches `session.execution.started`, because opencode git-snapshots the
work tree first. Create test sessions against a small directory:

```sh
"$CODER" --global-config "$CFG" ssh ALF-UAT -- "mkdir -p /tmp/octest && echo hi > /tmp/octest/a.txt"
```

Then `POST /api/session` with `{"location":{"directory":"/tmp/octest"}}`.
`POST …/prompt` is **async** — it returns 200 immediately; poll
`GET …/message` or watch the event stream.

## The wire model (summary — details in `subagents-alfuat.md`)

Tool name is `subagent`, input `{agent, description, prompt, background}`.
It spawns a **child session** with `parentID`, whose turn streams over the
same global `/api/event` connection under its own `sessionID`, using the
*identical* event vocabulary.

Linking a tool call to its child is direct, from two sources:

- **live** — `session.tool.progress` on the parent carries `callID` plus
  `data.metadata.metadata.sessionID` (note the doubled nesting)
- **history** — the stored tool part's `state.metadata.sessionID`

So there is no `parentID` scan and no ambiguity between concurrent
dispatches. `cost` is always `0` on both parent and child — **show tokens,
never dollars**. Parent and child are metered separately, so a sub-agent
token line is additive, not a double-count.

## Phase 1 — done. What it gives you

All in `web/src/stores/opencode.js`.

**Store state**: `childSessions` (keyed by child sessionID) and
`callChildIndex` (callID → child sessionID).

**Exports — this is the API Phases 2–4 consume:**

| Export | Use |
|---|---|
| `SUBAGENT_TOOL` | `"subagent"` |
| `isSubagentPart(part)` | detection for `MessageView`'s part loop |
| `childForCall(callID)` | the single lookup a card renders from |

A child record is:

```js
{ sessionID, parentSessionID, callID, agent, model, title, task,
  status: "running" | "completed" | "error",
  messages: [], tokens, startedAt, endedAt, error }
```

`messages` holds the same normalized message shape as the main transcript
(`{id, role, parts[], text, tokens, cost, createdAt}`), so anything that
renders parent messages can render a child's.

**Behavioural changes**: the old session filter is now a router — active
session drives the main transcript, a known child drives its own, anything
else is dropped. The `child` local being non-null makes every case skip
session-wide state (streaming flag, model selection, usage totals, error
banner); a sub-agent failing marks its own record rather than blanking the
session. `connectToSession` clears child state and calls
`backfillChildSessions()`, which rebuilds cards from stored tool parts.

Also fixed en route: `normalizeRestToolState` was **dropping
`state.metadata`** (which carries the linkage) and `normalizeContentItem`
was **dropping `input`** (the dispatch args). Both are preserved now.

**Verified live**: opening a session with a dispatch issues
`GET /session/{childID}` and `GET /session/{childID}/message`, both 200.

## Phases remaining

### Phase 2 — repoint `SubagentView.vue`

Keep the template and CSS; swap the data source. It currently reads
`store.toolResults[toolCallId].details.results` (a pi-era whole-state blob
that no longer exists). Point it at `childForCall(callID)`.

- Props become `callID` + `args` (the tool part's `input`).
- One card per call — V2 has no chain/parallel dispatch primitive, so drop
  `mode` and `step` from the header. Parallelism is just several concurrent
  calls, one card each.
- `resultStatus()` reads child `status`, not pi's `exitCode === -1`.
- `activityItems()` maps the child's **parts** (`type: 'text' | 'tool'`)
  instead of pi's `messages[].content[]` blocks.
- Keep: the live duration ticker, placeholder cards for the window before
  the first event, and the `#tc-<callID>` anchor (the header badge in
  Phase 4 jumps to it).
- Show tokens, not cost.

### Phase 3 — render it

In `web/src/components/chat/MessageView.vue`, branch in the part loop
before the generic `<details class="tool">` (line ~54): if
`isSubagentPart(part)`, render `<SubagentView>` instead. Today a dispatch
shows as a bare collapsed `▶ subagent` row — that's the fallback being
replaced.

### Phase 4 — header badge + usage popover, and cleanup

- Restore the running-sub-agent count badge in `ChatHeader.vue` near the
  meta line (~L115). `.subagent-badge` CSS already exists. Click jumps to
  `#tc-<callID>`. Reference implementation: `git show 612d4b0 -- web/src/ChatHeader.vue`.
- Rewrite `UsagePopover.vue` (lines 9–30) against `childSessions`.
- **Then delete `toolResults` and the `subagentDetails()` stub from
  `opencode.js`.** They are dead now but `UsagePopover.vue:9` still imports
  them, so they were deliberately left in place to keep the build green
  through Phases 1–3. This is the only intentional loose end.

### Phase 5 — `AgentsDialog.vue` (lowest value)

Orphaned; targeted a `/api/agents` CRUD route V2 does not have (only
read-only `GET /api/agent`). Either reduce to a read-only roster of the
`mode: "subagent"` agents (`general`, `explore`) or delete it. Note
`loadAgents()` filters subagent-mode agents out of the composer picker —
keep that, but retain them in a separate list if the dialog stays.

## Reproducing a dispatch for testing

```
Use the subagent tool to dispatch the explore subagent with the task:
list the files in /tmp/octest and report what you find.
```

Known-good artifacts from the verification run are in the session
scratchpad as `alfuat-openapi.json`, `alfuat-sse.txt` (a full tap
including a live dispatch), `alfuat-parent-msgs.json` and
`alfuat-child-msgs.json`. If they've been cleaned up, re-capture with a
tap on `GET /api/event` while prompting the above.

## Untested edges

- `background: true` on the dispatch input — behaviour unknown.
- Concurrent/parallel dispatches. Linkage is per-`callID` so it should
  hold, but several in-flight children have never been exercised.
- A *failing* sub-agent. The error path (`status: "error"`) is wired from
  the spec but no failure was ever captured on the wire.
- Reconnecting mid-run. `session.tool.success` settles a child defensively
  for this case, but it hasn't been tested.
