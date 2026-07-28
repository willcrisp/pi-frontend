# OpenCode V2 HTTP API reference (for this frontend)

This frontend (`web/src/stores/*.js`) talks directly to an OpenCode V2
server's HTTP/SSE API. Getting field names wrong here is a silent runtime
bug, not a compile error.

## Source of truth: the live server's own OpenAPI

The V2 server serves its OpenAPI 3.1 spec at `/openapi.json`. That's the
only ground truth — a packaged SDK, a hosted docs page, or this file can
all drift from the specific server you're pointed at. Verify against the
live spec before relying on a field name.

```sh
# Get the CLI:
npm install -g opencode-ai@next   # ships binary `opencode2`
opencode2 serve --hostname 127.0.0.1 --port 4096

# Server auto-creates an auth password; retrieve with:
opencode2 service password
# Basic auth: `Authorization: Basic $(echo -n opencode:$PW | base64 -w0)`

# Inspect the spec:
curl -s http://127.0.0.1:4096/openapi.json | jq '.paths | keys'
curl -s http://127.0.0.1:4096/openapi.json | jq '.components.schemas | keys'
```

Notes:
- The spec is at `/openapi.json` (unprefixed), **not** `/doc` or `/api/doc`.
- All operational routes live under `/api/*`.
- Every operation has `security: []` in the current build, but requests
  without basic-auth headers still return 401 — auth is enforced out-of-band.
- The frontend proxies through `/api/<port>/api` (Vite dev proxy strips
  `/api/<port>`, forwards `/api/...` to the server). `apiBase()` in
  `web/src/stores/ssh.js` builds that prefix.

## Verified endpoint inventory (build: opencode-ai@next 0.0.0-next-202606270058)

Every path below has been probed against a live server and either used by
this frontend or flagged as a known gap.

### Session lifecycle

| Method | Path | Notes |
|---|---|---|
| GET | `/api/session` | Wired: `projects.js#fetchSessions`. Returns `{data: SessionV2.Info[]}` |
| GET | `/api/session/active` | Not wired. Current active-session pointer |
| GET | `/api/session/{sessionID}` | Not wired. Single-session detail |
| POST | `/api/session` | Wired: `projects.js#startNewChat`. Body `{id?, agent?, model?, location?}` where `location` is `{directory, workspaceID?}` (`Location.Ref`) |
| ❌ | ~~DELETE `/api/session/{sessionID}`~~ | **Not exposed in this build.** `removeSession` is client-side-only |
| ❌ | ~~PATCH `/api/session/{sessionID}`~~ | **Not exposed.** RenameDialog is a no-op |

### Prompts and execution

| Method | Path | Notes |
|---|---|---|
| POST | `/api/session/{sessionID}/prompt` | Wired: `sendPrompt`. **Body must wrap under `prompt`**: `{prompt: {text, files?, agents?}, id?, delivery?, resume?}`. A flat `{text}` 400s |
| POST | `/api/session/{sessionID}/interrupt` | Wired: `abortSession` |
| POST | `/api/session/{sessionID}/wait` | Not wired. Sync wait for completion |
| GET | `/api/session/{sessionID}/message` | Wired: `refreshActiveMessages` |
| GET | `/api/session/{sessionID}/message/{messageID}` | Not wired |
| GET | `/api/session/{sessionID}/context` | Not wired. Server-computed context/tokens; UI currently derives from messages |
| GET | `/api/session/{sessionID}/event` | Not wired. Session-scoped SSE — cleaner than filtering the global stream |

### Session-level operations

| Method | Path | Notes |
|---|---|---|
| POST | `/api/session/{sessionID}/model` | Wired: `setModel` → `pushSessionModel`. Body `{model: Model.Ref}` |
| POST | `/api/session/{sessionID}/agent` | Wired: `setAgent`. Body `{agent}` — must be agent `id`, not display `name` |
| POST | `/api/session/{sessionID}/compact` | Wired: `compactSession`. **Returns 503 "Session compact is not available yet" in this build** — endpoint reserved but unimplemented |
| POST | `/api/session/{sessionID}/revert/stage` | Not wired. Alternative to a fork endpoint |
| POST | `/api/session/{sessionID}/revert/commit` | Not wired |
| POST | `/api/session/{sessionID}/revert/clear` | Not wired |
| ❌ | ~~POST `/api/session/{sessionID}/fork`~~ | **Not exposed.** Use `revert/*` instead |
| ❌ | ~~POST `/api/session/{sessionID}/share`~~ | **Not exposed at all** in this build |
| ❌ | ~~POST `/api/session/{sessionID}/command`~~ | **Not exposed.** Slash commands are sent as raw prompt text |

### Permissions (tool-approval gating)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/permission/request` | Not wired. Poll for all pending requests (fallback for missed SSE) |
| GET | `/api/permission/saved` | Not wired. List always-allow rules |
| DELETE | `/api/permission/saved/{id}` | Not wired. Revoke a saved rule |
| GET | `/api/session/{sessionID}/permission/{requestID}` | Not wired. Fetch specific request |
| POST | `/api/session/{sessionID}/permission/{requestID}/reply` | Wired: `permission.js#respond`. Body `{reply: "once"\|"always"\|"reject", message?}` |
| POST | `/api/session/{sessionID}/permission` | Not wired. Server-side create — probably not caller-facing |

### Questions (interactive Q&A)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/session/{sessionID}/question` | Not wired. Returns `{data: QuestionV2.Request[]}` |
| POST | `/api/session/{sessionID}/question/{requestID}/reply` | Wired: `question.js#reply`. Body **`{answers: string[][]}`** — see below. 204 on success |
| POST | `/api/session/{sessionID}/question/{requestID}/reject` | Wired: `question.js#reject`. **No body.** 204 on success |
| GET | `/api/question/request` | Wired: `question.js#loadPendingQuestions`. Returns `{location, data: QuestionV2.Request[]}` |

**One ask carries many questions, and answers are positional by label.** This
is the shape that used to be guessed wrong, so spelling it out:

```
QuestionV2.Request = {id: "que_...", sessionID, questions: Info[], tool?}
QuestionV2.Info    = {question, header, options: Option[], multiple?, custom?}
QuestionV2.Option  = {label, description}     // both required — and NO id
QuestionV2.Reply   = {answers: string[][]}    // QuestionV2.Answer = string[]
QuestionV2.Tool    = {messageID, callID}
```

- **Options have no `id`.** An answer names its choice by the option's `label`,
  verbatim.
- **`answers` is positional over `questions`** — one entry per question, in
  order. Each entry is a *list* of labels, because a question with
  `multiple: true` accepts several. A single-select answer is a one-element
  list.
- `custom: true` means free text is allowed as an answer; the label sent is
  then the user's own text rather than one of the options.
- Verified against a live server: `{option, text}` (or any body without
  `answers`) is rejected **400** `InvalidRequestError: Missing key at
  ["answers"]`, while `{answers: [["Yes"]]}` passes body validation and only
  404s on an unknown `requestID` — body validation runs *before* the question
  lookup, which makes that pair a clean discriminator for the shape.

### Metadata

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Wired: `initOpenCode` |
| GET | `/api/location` | Not wired. Returns current server's `{directory, project: {id, directory}}` — the closest thing to project metadata (no listing endpoint) |
| GET | `/api/model` | Wired: `loadModels`. Returns `Model.Info[]` |
| GET | `/api/agent` | Wired: `loadAgents`. Read-only — see "Agent definitions live on disk" below |
| GET | `/api/command` | Wired: `loadCommands` |
| GET | `/api/skill` | Wired: `loadSkills` |
| GET | `/api/reference` | Not wired |

### Providers, integrations, credentials

The credential model is integration-driven — there is no top-level list of
credentials, and no `POST /api/credential`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/provider` | Not wired. Providers that already have a working connection (differs from integration list) |
| GET | `/api/provider/{providerID}` | Not wired |
| GET | `/api/integration` | Wired: `providers.js#loadIntegrations`. ~150 entries: `{id, name, methods, connections[]}` |
| GET | `/api/integration/{integrationID}` | Not wired |
| POST | `/api/integration/{integrationID}/connect/key` | Wired: `connectKey`. Body `{key, label?}` → 204. Attaches an API key |
| POST | `/api/integration/{integrationID}/connect/oauth` | Not wired |
| POST | `/api/integration/attempt/{attemptID}/complete` | Not wired. Complete an OAuth attempt |
| DELETE | `/api/integration/attempt/{attemptID}` | Not wired. Cancel an attempt |
| GET | `/api/integration/attempt/{attemptID}` | Not wired |
| PATCH | `/api/credential/{credentialID}` | Not wired. Edit label |
| DELETE | `/api/credential/{credentialID}` | Wired: `removeCredential`. Credential ID comes from an integration's `connections[]` |

Connection shape (from a real integration `.connections[]` after connect):
`{type: "credential", id: "cred_...", label: "default"}`

### Filesystem, PTY, events

| Method | Path | Notes |
|---|---|---|
| GET | `/api/fs/list` | Not wired for palette (see below). Params: `location[directory]`, `path` (relative). Non-recursive — returns one directory level, `{data: [{path, type}]}` |
| GET | `/api/fs/find` | Not wired. Query-based search (`query` required) |
| GET | `/api/fs/read/*` | Not wired. Read file contents |
| ❌ | ~~/api/vcs/*~~ | **No git/vcs routes at all** in this build. `git.js` uses PTY (`git branch -a`, `git checkout`) — the only viable path |
| GET | `/api/pty` / `/{ptyID}` | Wired: `pty.js` for create/delete/connect flow |
| POST | `/api/pty` | Wired: `pty.js#runCommand` |
| DELETE | `/api/pty/{ptyID}` | Wired: cleanup after one-shot run |
| POST | `/api/pty/{ptyID}/connect-token` | Wired |
| GET | `/api/pty/{ptyID}/connect` | Wired: WebSocket, streams stdout |
| PUT | `/api/pty/{ptyID}` | Not wired. Update PTY (resize?) |
| GET | `/api/event` | Wired: `setupEventStream` (SSE) |

**Why `fs/list` isn't wired for the file palette:** the endpoint is
single-level. The palette needs a recursive file tree, which only the
PTY-based `fdfind` / `fd` / `git ls-files` path in `filesearch.js`
delivers today. If a recursive endpoint lands, replace the loop there.

## Confirmed schemas

- **`Location.Ref`** = `{directory: string, workspaceID?: string}`
- **`Model.Ref`** = `{id: string, providerID: string, variant?: string}`
- **`PromptInput`** = `{text: string, files?: PromptInput.FileAttachment[], agents?: [], metadata?, delivery?, resume?}` — `additionalProperties: false`
- **`PromptInput.FileAttachment`** = `{uri: string, name?, description?, mention?}`. `uri` accepts a
  `data:<mime>;base64,...` URL; the server parses it and stores the attachment as
  `Prompt.FileAttachment` = `{data: base64, mime, source: {type: "inline"}, name?}`. Sending
  `{filename, mime, url}` (the FilePart render shape) 400s — the schema is closed.
- Stored **user messages** carry those attachments at the top level: `{id, time, text, files, type: "user"}`
- **`PermissionV2.Reply`** = `"once" | "always" | "reject"`
- **`PermissionV2.Request`** = `{id: "per_..." , sessionID: "ses_...", action: string, resources: string[], save?: string[], metadata?: object, source?: object}`
- **`SessionV2.Info`** = `{id, title?, agent, model, location: Location.Info, cost, tokens, parentID?, projectID, subpath, revert?, time}`

## SSE event catalog

Envelope: `{id: "evt_...", type: string, data: object, metadata?, durable?, location?}`. Types seen in the spec:

- `server.connected` — wired, sets `connected = true`
- `message.updated`, `message.part.updated`, `message.part.removed`, `message.removed` — wired
- `session.execution.started` / `.completed` / `.failed` — wired
- `session.idle` — wired
- `session.model.selected` — wired, syncs local model selection
- `session.input.admitted` — wired (acknowledged, no state change)
- `permission.v2.asked` — wired, enqueues in permission store
- `permission.v2.replied` — wired, clears queue entry
- `question.v2.asked` — wired, enqueues in question store (`data` is a `QuestionV2.Request`)
- `question.v2.replied` / `question.v2.rejected` — wired, clears the queue entry. Both key the
  question as **`data.requestID`** (`data.id` does not exist on these two; the envelope's `id` is
  the `evt_` id). `.replied` also carries `answers`
- `pty.created` / `.updated` / `.exited` / `.deleted` — wired (no state change today)
- `file.edited` / `file.watcher.updated` — not wired
- `integration.updated` / `integration.connection.updated` — not wired; would let the providers dialog auto-refresh
- `plugin.added`, `catalog.updated`, `project.directories.updated`, `models-dev.refreshed` — not wired

## Agent definitions live on disk, not behind an API

`GET /api/agent` is the *only* agent route: there is no create/update/delete,
and — unlike V1, which has `GET`/`PATCH /config` — the V2 surface has no
`/api/config` either. So a sub-agent can only be **defined** by writing the file
opencode's config loader reads. That is what `stores/subagents.js` does, through
the PTY runner (`stores/remotefs.js`), since there is no fs-write route.

Verified against a live `opencode2 serve` (agent file written, server restarted,
`GET /api/agent` re-read):

| Scope | Path |
|---|---|
| Project | `<directory>/.opencode/agent/<name>.md` (or `.opencode/agents/`) |
| Global | `~/.config/opencode/agent/<name>.md` (or `agent**s**/`) |

```markdown
---
description: Reviews PRs for style violations.
mode: subagent
model: anthropic/claude-sonnet-4-6
variant: high
temperature: 0.2
tools:
  write: false
---
You are a strict PR reviewer…
```

- **The body is the prompt.** It surfaces as `AgentV2.Info.system`. Never also
  put a `prompt:` key in the frontmatter.
- **Allowed frontmatter keys** are exactly `name, model, variant, description,
  mode, hidden, color, steps, options, permission, disable, temperature,
  top_p`. Any other key is silently swallowed into `options`.
- **`model` is a `providerID/modelID` string** and **`variant` is the
  reasoning-effort preset** — the pair comes back as
  `model: {id, providerID, variant}`. Variant names are per-model; the catalog
  reports them in `Model.Info.variants` (as `{id, headers, body}` objects on
  some builds, bare strings on others).
- `temperature` lands in `request.body.temperature`; `tools: {name: false}`
  lands in `permissions` as a deny rule.
- **Config is read once at startup and is NOT hot-reloaded.** A file written
  while the server is up does not become a live agent until it restarts —
  confirmed by adding a file and re-reading `/api/agent`. The sub-agents dialog
  says so, and marks definitions the roster hasn't loaded as "restart to apply".

## Known gotchas

- **Agents are addressed by `id`, not `name`.** `{id: "build", name: "Build"}` — send `build`. Sending `Build` fails with `Agent not found: "Build"`.
- **`fs/list` `path` is relative to `location.directory`.** Sending an absolute path when the location is the server's own workspace returns 500 because the server sandboxes to the project root.
- **`compact` is stubbed server-side in this build** — the endpoint exists (POST `/api/session/{id}/compact`) but always returns 503 with `{message: "Session compact is not available yet"}`. Frontend surfaces this as an error banner.
- **Question options are identified by `label`, not by an id** — there is no id
  on `QuestionV2.Option`. And a single `question.v2.asked` is a *batch*: the
  payload is `{questions: [...]}`, never a lone `question` string. Reading
  `data.question`/`data.options` yields `undefined` and silently renders an
  empty dialog.
- **Auth is basic and out-of-band.** The OpenAPI declares `security: []` on every op, but a request without the `Authorization: Basic ...` header returns 401. Password comes from `opencode2 service password`.
