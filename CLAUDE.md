# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

pi-web: a minimal dark-themed web frontend for the [pi coding agent](https://github.com/badlogic/pi-mono), with a sidebar for switching between projects and each project's chat history. It's a two-part system:

- `server/` — a Rust (axum) server. It manages a pool of `pi --mode rpc` child processes, one per "project" working directory, and transparently bridges each one's newline-delimited JSON stdio to WebSocket clients at `/ws/{projectId}`. It does **not** parse pi's RPC protocol at all — beyond one small exception (peeking at `get_session_stats` responses to learn where a project's session history lives on disk) it's a dumb byte-for-line pipe, which is what keeps it compatible as pi evolves. Projects run concurrently (an agent keeps working in a project you're not currently viewing) and are added/removed via `/api/projects` REST endpoints from the sidebar, persisted to `<data-dir>/projects.json`. With `--ssh`, every project's pi process runs on one remote host over SSH instead of locally (see "Remote setup" in the README). It also serves the built frontend as static files.
- `web/` — a Vue 3 + Vite frontend (plain JS, no TypeScript; Vue is the only runtime dependency). The browser speaks pi's RPC protocol directly over the WebSocket — the server has no involvement in interpreting messages. The sidebar lists known projects and, for the active one, its past chats (via `switch_session`/`new_session`).

There is no root `package.json`; `server/` and `web/` are independent projects (Cargo and npm respectively) built and run separately.

## RULES
Always work of main branch and commit directly too it

## Commands


Build the frontend (one-time or after frontend changes), then run the server:

```sh
cd web && npm install && npm run build
cd server && cargo run --release -- --cwd path/to/your/project
```

Open http://127.0.0.1:3210. `--cwd` only seeds the first project on the very
first run (no persisted `projects.json` yet); after that, projects are
added/removed from the sidebar and the list persists across restarts.

Frontend dev loop (hot reload, run alongside the server):

```sh
cd server && cargo run --release -- --cwd path/to/your/project   # terminal 1
cd web && npm run dev                                             # terminal 2
```

Vite serves the UI on :5173 and proxies `/ws` and `/api` to the Rust server on :3210 (see `web/vite.config.js`).

Other useful commands:

```sh
cd server && cargo build --release   # build only
cd server && cargo check             # fast type/borrow check without codegen
cd web && npm run build              # production build to web/dist
```

There is no test suite or linter configured in either project.

### Server CLI flags

| Flag | Default | |
|---|---|---|
| `--port N` | `3210` | HTTP/WS port (binds `127.0.0.1` only) |
| `--cwd DIR` | `.` | Working directory for the seed project on first run, local or on the remote host (`--ssh` mode) |
| `--pi-bin PATH` | `pi` | pi executable, local or remote |
| `--web-dir DIR` | `web/dist` | Built frontend to serve |
| `--login-helper PATH` | `server/pi-login/login-helper.mjs` | Node script driving pi's provider connect flow (see "Provider connect") |
| `--data-dir DIR` | `~/.pi-web` | Where `projects.json` is persisted |
| `--ssh user@host` | | Relay mode: exec pi for every project over SSH on one remote machine instead of spawning it locally. Only seeds `<data-dir>/ssh.json` on the very first run — after that, edit the target from the popup on the header's connection dot (`/api/ssh`) instead of restarting with new flags |
| `--ssh-identity PATH` | | Private key for `--ssh` (omit if the remote uses Tailscale SSH / an agent) |
| `--ssh-port N` | `22` | SSH port for `--ssh` |
| `-- <args>` | | Everything after `--` is passed to pi for every project (e.g. `-- --model sonnet --continue`) |

## Architecture

### Provider connect (the one place the server does more than pipe bytes)

pi's per-project RPC protocol has **no** login/auth command — connecting a
provider (API key or OAuth subscription, i.e. the TUI's `/login`) is
"app-owned" and lives in pi's `ModelRuntime`, not the wire protocol. So the
connect UI can't be a pure `pi.js` change like everything else. It works
through a separate, self-contained path that doesn't touch the per-project
pi bridge at all:

- `server/pi-login/login-helper.mjs` — a headless Node script that
  `import`s pi's own `ModelRuntime` (from the installed pi package, located
  next to the `--pi-bin` launcher) and exposes its `getProviders()` /
  `login()` / `logout()` over newline-delimited JSON on stdio. It drives the
  exact same `ModelRuntime.login(id, method, interaction)` the interactive
  TUI does, forwarding every prompt/notify (API-key field, OAuth URL, device
  code, select) to the client.
- `server/src/main.rs` `/ws-auth` — spawns one helper per WebSocket client
  and bridges its stdio, same pattern as the per-project bridge but 1:1 and
  short-lived. It resolves pi's bundled `node` + package dir from the `pi`
  launcher location (`resolve_pi_node`).
- `web/src/auth.js` + `ConnectDialog.vue` — reactive `authStore` + the
  connect modal (opened from the sidebar "connect model" button).

Credentials land in pi's `auth.json` on the machine running the helper.
**Not supported in `--ssh` relay mode** (the credential would be written on
the pi-web host, not the remote host that actually runs pi) — the `/ws-auth`
handler sends an error frame and closes; connect there is still done with
`/login` in a terminal on the remote host.

### The protocol boundary is in the browser, not the server

The single most important thing to know: `server/src/main.rs` never deserializes the JSON it shuttles between `pi`'s stdio and the WebSocket. All protocol knowledge — every RPC command name, every event type, every payload shape — lives in `web/src/pi.js`. When adding support for a new pi RPC command or event, there is nothing to change server-side; do it entirely in `pi.js` (and the Vue components that consume the store).

### Data flow

```
one pi child process per project (stdin/stdout, newline-delimited JSON)
        │
   server/src/main.rs  (a pool: HashMap<projectId, RunningProcess>)
   - per project: mpsc channel:      WS client -> pi stdin
   - per project: broadcast channel: pi stdout -> all WS clients on /ws/{projectId}
   - peeks get_session_stats responses to learn each project's session_dir
   - /api/projects (list/add/remove), /api/projects/{id}/sessions (list chats)
        │  (WebSocket, one JSON object per text frame)
        ▼
web/src/pi.js
   - connectToProject(id) opens /ws/{id}, sends get_state / get_messages /
     get_available_models / get_session_stats on open; switching projects
     tears down the old socket and opens a new one
   - send(cmd) / sendPrompt(text) / abort() / setModel() /
     setThinkingLevel() / newSession() / switchSession() write RPC commands
   - handle(ev) is the single switch over incoming event types,
     mutating the reactive `store` object (one project's chat at a time)
        │
        ▼
web/src/projects.js — REST client + reactive `projectsStore` for the
   project list and the current project's session (chat) list
        │
        ▼
web/src/App.vue (composer, header, model/thinking selects)
  ├─ Sidebar.vue (project list + add/remove, chat history for current project)
  ├─ MessageView.vue (renders one message: text / thinking / toolCall blocks)
  └─ UsagePopover.vue (session token/cost totals + sub-agent breakdown)
```

`store` (in `pi.js`, the active project's chat) and `projectsStore` (in `projects.js`, the project/session lists) are the reactive sources of truth for the whole UI — there is no other state management. Components read from them directly and call the exported functions to act.

### Server internals (`server/src/main.rs`)

- `AppState` holds `projects: RwLock<HashMap<id, ProjectEntry>>` (persisted metadata) and `running: RwLock<HashMap<id, RunningProcess>>` (live pi processes) separately — a project can exist without a running process, and `ensure_running` lazily spawns/respawns one on demand (all known projects are also started eagerly at boot).
- Per project: one `mpsc::channel` carries lines from any connected WS client into that project's pi stdin; one `broadcast::channel` carries every line of that pi process's stdout out to all WS clients on `/ws/{projectId}` — this means multiple browser tabs on the same project stay in sync automatically.
- A lagging client (slow consumer) just skips missed broadcast messages rather than blocking others; the frontend recovers by re-requesting `get_messages` on reconnect (see `ws.onclose` in `pi.js`, which retries the connection after 1.5s).
- If a project's `pi` child process exits, only that project's entry is dropped from `running` (next connect respawns it) — the server itself keeps running, unlike the old single-process design.
- When an SSH target is set (`AppState.ssh: RwLock<SshConfig>`, runtime-editable via `/api/ssh` — see below — and persisted to `<data-dir>/ssh.json`), `spawn_child` execs pi over `ssh` instead of spawning it locally (one remote host shared by every project); local-filesystem operations (path validation on add, session-dir listing) are skipped/degrade to empty rather than erroring, since paths are on the remote host. Changing the target via `PUT`/`DELETE /api/ssh` respawns every known project's pi process against it (`respawn_all`) — the watcher task that removes a dead process from `running` guards the removal with `Arc::ptr_eq` so a respawn's new process (inserted under the same id before the old one is killed) can't be evicted by the old process's own cleanup.
- Windows spawns `pi` via `cmd /C` since it installs as a `.cmd` shim.

### Frontend internals (`web/src/`)

- `pi.js` — WebSocket client + the reactive `store` for one project's chat at a time. All RPC event handling funnels through `handle(ev)`.
- `projects.js` — REST client + reactive `projectsStore` (project list, current project's session/chat list). Session switching itself goes over the WebSocket via pi's `new_session`/`switch_session` RPC commands.
- `Sidebar.vue` — project list (add/remove, backed by `/api/projects`) and, for the active project, its paginated chat history (backed by `/api/projects/{id}/sessions`).
- `App.vue` — top-level layout: sidebar, header (connection dot, model, session name, usage popover), scrollable message list, composer (textarea + send/stop), model/thinking-level selects. Auto-scrolls the message pane unless the user has scrolled up.
- `ssh.js` — REST client + reactive `sshStore` for the runtime-editable SSH target (`/api/ssh`, `/api/ssh/test`), same conventions as `projects.js`.
- `SshPopover.vue` — click-toggled popup on the header's connection dot (`ChatHeader.vue`) for viewing/testing/saving/clearing the SSH target. Unlike `UsagePopover.vue` (hover-triggered, read-only), this is click-toggled with outside-click/Escape-to-close since it's a form.
- `MessageView.vue` — renders a single message's content blocks (`text`, `thinking`, `toolCall`). Tool call results are looked up live from `store.toolResults` by `toolCallId`, not embedded in the message itself.
- `UsagePopover.vue` — session-level token/cost stats from `get_session_stats`, plus a **heuristic** sub-agent breakdown: any tool result whose `details.results` is an array of `{ agent, model, usage, stopReason, errorMessage }` is treated as a sub-agent dispatch (the shape produced by pi-mono's example `subagent` extension). Per-agent duration is measured client-side from tool-call start/end, since that extension doesn't report elapsed time itself. This degrades gracefully to "no sub-agents used this session" when no such extension is installed — see the README's "TODO: pi-side setup for the token usage popover" section for how to wire one up in a local `pi` config.
- Styling is a single hand-written `style.css` (CSS custom properties for the dark theme) — no CSS framework or utility classes.

### Known gaps (see README "Not yet implemented")

- No markdown rendering of assistant text (plain text only).
- No handling of `extension_ui_request` dialogs (confirm/select/input from extensions).
- No image support in prompts.
- No idle eviction of project processes (every added project's `pi` process runs until removed or the server restarts).
- No chat-history browsing when an SSH target is set (session files live on the remote host; new chats and switching still work, there's just no discovery of past ones).

When working in this area, check whether a change belongs in `pi.js` (protocol/state) versus the `.vue` components (presentation) before touching the server — the server almost never needs to change for frontend-visible features.
