# OpenCode V2 frontend handover

Status snapshot as of `main` at `3612a66`. What works today, what doesn't,
and what to pick up next.

> **In-flight work not covered here:** inline sub-agent rendering is
> partly landed (store layer done, UI phases remaining). See
> `docs/handover-subagents.md`, and `docs/subagents-alfuat.md` for the
> verified API ground truth — including a build-divergence warning that
> supersedes this file's SSE and prompt-body notes.

## What works end-to-end

- Connect to a local `opencode2 serve` on any port (dev proxy at `/api/<port>/api`)
- List / open / create sessions; sessions grouped by project directory in the sidebar
- Send prompts and stream assistant/tool responses (SSE)
- Switch model + variant, switch agent per session
- Interrupt a running session
- Integration/credential management: add an API key for any of ~150 providers, remove credentials
- Permission gating dialog: catches `permission.v2.asked` events and replies with once/always/reject
- Git branch display + checkout (via PTY, not a server route)
- File palette (fdfind / fd / git ls-files via PTY)

All the above is verified against a live `opencode-ai@next` server —
schemas and endpoints are documented in `docs/opencode-api.md`.

## Blocked on the OpenCode server (not fixable in the frontend)

These routes / features don't exist in the current preview build. When a
newer server exposes them, we can re-add the frontend paths:

| Missing | Impact | Verify with |
|---|---|---|
| `DELETE /api/session/{id}` | Delete is client-only; session reappears on refresh | `curl -X DELETE http://…/api/session/{id}` |
| `PATCH /api/session/{id}` | RenameDialog is a no-op close | `curl -X PATCH …` |
| `POST /api/session/{id}/fork` | No branch-off-a-message flow | check `/openapi.json` |
| `POST /api/session/{id}/share` | No share link | ditto |
| `POST /api/session/{id}/compact` | Route exists but returns 503 "not available yet" | already wired; will start working when server lifts the stub |
| `POST /api/session/{id}/command` | Slash commands sent as raw text | ditto |
| `/api/vcs/*` | Git operations go through PTY | ditto |
| Recursive `/api/fs/list` | Palette must use PTY | ditto |

**Verification script when a new server build lands:**
```sh
curl -s http://127.0.0.1:4096/openapi.json | jq -r '.paths | keys[]' | sort > new-paths.txt
diff <(grep -E '/api/(session/\{sessionID\}$|session/\{sessionID\}/(fork|share|command)|vcs)' docs/opencode-api.md) new-paths.txt
```

When any of these appear, revert the "Drop calls to session command/delete/rename
routes that don't exist" commit (`457f680`) and the "Remove session fork/share"
commit (`6997a0b`) as starting points — the removed code is the reference
implementation.

## High-value features we could add today (server supports)

Rough priority order:

### 1. Interactive Q&A (`question.v2.asked` events)
Session tools can ask the user structured questions mid-execution. Events
already fire; we just don't have a dialog.
- Routes: `POST /api/session/{sid}/question/{rid}/reply`, `/reject`
- Store: mirror `stores/permission.js`
- Dialog: mirror `PermissionDialog.vue` — but questions have typed options
  (see `QuestionV2.Option` schema)
- Wire in `App.vue` next to `PermissionDialog`

### 2. Session-scoped SSE
`GET /api/session/{sid}/event` streams only the active session's events.
Currently we filter the global `/api/event` stream client-side; switching
would reduce noise and CPU. Downside: we lose global events like
`server.connected` and `integration.*`, so keep both streams or split
handlers.

### 3. Server-computed context stats
`GET /api/session/{sid}/context` returns the real context/token usage the
server sees. We currently reconstruct it from message tokens in
`updateSessionStats`. Server truth would fix drift.

### 4. OAuth for providers that support it
`POST /api/integration/{id}/connect/oauth` starts an OAuth flow (returns
an attempt ID). Complete with `POST /api/integration/attempt/{attemptID}/complete`.
Providers with `methods[].type === "oauth"` (Anthropic, OpenAI ChatGPT
account, OpenCode Zen) currently show up in ProvidersDialog with only the
key path available.

### 5. Session revert as fork-substitute
`POST /api/session/{sid}/revert/stage|commit|clear` — the API's answer to
"go back to before message X". Not a session fork but the closest thing.
Wire into `MessageView.vue` per-message actions.

### 6. Saved permission rules
`GET /api/permission/saved` + `DELETE /api/permission/saved/{id}` — lets
the user revoke previously-granted "always allow" rules. Small dialog off
the sidebar gear icon.

### 7. File preview
`GET /api/fs/read/*` returns file contents. Tool-call outputs that reference
files could link to a preview pane. Nice-to-have.

### 8. Auto-refresh on integration updates
Events `integration.updated` and `integration.connection.updated` fire when
credentials change. Wire them so ProvidersDialog / model list stays live
without manual reload.

## Frontend housekeeping

### Orphaned dialog components
Five dialog files exist but are never mounted anywhere:
- `RenameDialog.vue` (rename endpoint doesn't exist anyway)
- `AgentsDialog.vue` (agents work via the composer's dropdown; this dialog is unused)
- `CommandPalette.vue`
- `ConfirmDialog.vue`
- `ExtensionUIDialog.vue`

Decision needed on each: mount it (wire a launcher and shortcut), or delete
it. `stores/renameDialog.js` and `stores/confirm.js` are the state backing
stores — same question.

### Auth password UX
Users have to run `opencode2 service password` in a terminal and paste the
password into the ConnectDialog. For local mode this could be automated
via a small extra endpoint (or a well-known file at
`~/.local/share/opencode2/password`) — worth checking whether the server
exposes anything for this.

### Empty state
`App.vue`'s "Select or create a session" empty state has no visible
launcher for the ProvidersDialog. First-run UX for a fresh install
(no credentials configured) currently has no path to add one without
knowing to look in the sidebar gear icon.

### Frontend-only session archiving
`projects.js#archivedDirectories` hides project groups in the sidebar via
localStorage. There's no UI for actually toggling it — either add an
"Archive" action to project group headers or delete the store.

## Testing gaps

We verified request/response shapes against a live server but never ran a
prompt end-to-end with a real credentialed provider. Before shipping to
users, worth manually:

1. Boot server: `opencode2 serve --port 4096`
2. Get password: `opencode2 service password`
3. `cd web && npm run dev`
4. Connect in the UI with `opencode` / `<password>` on port 4096
5. Add an API key via Providers dialog (Anthropic or OpenAI)
6. Send a prompt that triggers a tool call requiring permission (e.g. "read a file")
7. Verify: prompt round-trip, streaming, permission dialog, allow-once → tool runs, session stats update

The permission dialog especially hasn't been exercised — event handling
matches the spec but a live approve/deny flow has never round-tripped.

## Reference: how to run + inspect the server

```sh
# Install
npm install -g opencode-ai@next   # binary: opencode2

# Run
opencode2 serve --hostname 127.0.0.1 --port 4096

# Auth password (auto-generated per install)
opencode2 service password

# Live OpenAPI spec
curl -s http://127.0.0.1:4096/openapi.json | jq

# List all paths and methods
curl -s http://127.0.0.1:4096/openapi.json | \
  jq -r '.paths | to_entries[] | .key as $k | .value | to_entries[] | "\(.key | ascii_upcase) \($k)"' | sort

# List schemas
curl -s http://127.0.0.1:4096/openapi.json | jq -r '.components.schemas | keys[]'
```

## Key files

- `web/src/stores/opencode.js` — REST + SSE client, session state
- `web/src/stores/projects.js` — session list, create, delete, group by directory
- `web/src/stores/permission.js` — permission queue + reply
- `web/src/stores/providers.js` — integration list + credential mgmt
- `web/src/stores/pty.js` — PTY WebSocket runner (used by git.js, filesearch.js)
- `web/src/stores/git.js` — branch info via PTY
- `web/src/stores/filesearch.js` — file palette via PTY (fdfind)
- `web/src/stores/ssh.js` — connection + auth headers (`apiBase()`, `authHeaders()`)
- `docs/opencode-api.md` — full verified API reference
