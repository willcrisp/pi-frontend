# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

pi-web: a minimal dark-themed web frontend for the [pi coding agent](https://github.com/badlogic/pi-mono), with a sidebar for switching between projects and each project's chat history. It's a two-part system:

- `server/` — a Rust (axum) server. It manages a pool of `pi --mode rpc` child processes, one per *chat* (a project working directory × one conversation), and transparently bridges each one's newline-delimited JSON stdio to WebSocket clients at `/ws/{projectId}?chat={chatId}` (`chatId` is an opaque client-chosen token). It does **not** parse pi's RPC protocol at all — beyond two small read-only peeks (at `get_session_stats` responses to learn where a project's session history lives on disk, and at `agent_start`/`agent_settled` events so the idle sweeper knows a process is safe to reap) it's a dumb byte-for-line pipe, which is what keeps it compatible as pi evolves. Chats run concurrently (an agent keeps working in a chat — or a project — you're not currently viewing; switching chats never touches its process), idle processes with no clients are reaped after a grace period and respawned on demand, and projects are added/removed via `/api/projects` REST endpoints from the sidebar, persisted to `<data-dir>/projects.json`. With `--ssh`, every pi process runs on one remote host over SSH instead of locally (see "Remote setup" in the README). It also serves the built frontend as static files.
- `web/` — a Vue 3 + Vite frontend (plain JS, no TypeScript; Vue is the only runtime dependency). The browser speaks pi's RPC protocol directly over the WebSocket — the server has no involvement in interpreting messages. The sidebar lists known projects and, for the active one, its past chats, each with a live status dot (working / unread) fed by that chat's own connection.

There is no root `package.json`; `server/` and `web/` are independent projects (Cargo and npm respectively) built and run separately.

## RULES
Always work of main branch and commit directly too it

## Commands


Build the frontend (one-time or after frontend changes) — `server/` embeds `web/dist` into the binary at compile time via `rust-embed`, so it must exist before building the server — then run the server:

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
| `--web-dir DIR` | *(embedded)* | Serve the frontend from a live directory instead of the `web/dist` copy embedded into the binary at compile time (dev loop) |
| `--login-helper PATH` | *(embedded)* | Node script driving pi's provider connect flow (see "Provider connect"); overrides the copy embedded into the binary at compile time |
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
- `web/src/stores/auth.js` + `ConnectDialog.vue` — reactive `authStore` + the
  connect modal (opened from the sidebar "connect model" button).

Credentials land in pi's `auth.json` on the machine running the helper.
**Not supported in `--ssh` relay mode** (the credential would be written on
the pi-web host, not the remote host that actually runs pi) — the `/ws-auth`
handler sends an error frame and closes; connect there is still done with
`/login` in a terminal on the remote host.

### The protocol boundary is in the browser, not the server

The single most important thing to know: `server/src/main.rs` never deserializes the JSON it shuttles between `pi`'s stdio and the WebSocket. All protocol knowledge — every RPC command name, every event type, every payload shape — lives in `web/src/stores/pi.js`. When adding support for a new pi RPC command or event, there is nothing to change server-side; do it entirely in `pi.js` (and the Vue components that consume the store).

### Data flow

```
one pi child process per chat (stdin/stdout, newline-delimited JSON)
        │
   server/src/main.rs  (a pool: HashMap<"projectId/chatId", RunningProcess>)
   - per chat: mpsc channel:      WS client -> pi stdin
   - per chat: broadcast channel: pi stdout -> all WS clients on
     /ws/{projectId}?chat={chatId}
   - peeks get_session_stats responses to learn each project's session_dir,
     and agent_start/agent_settled to track per-process streaming state for
     the idle sweeper (no clients + not streaming + grace period -> reaped)
   - /api/projects (list/add/remove), /api/projects/{id}/sessions (list chats),
     /api/projects/{id}/search (grep chat *content*, local or over SSH —
     bounded file/byte/result caps, raw substring scan so it stays outside
     pi's message schema)
   - /api/agents (list/save/delete sub-agent definition .md files, local
     or over SSH — see "Sub-agent support" below)
        │  (WebSocket, one JSON object per text frame)
        ▼
web/src/stores/pi.js
   - one live connection + reactive state object per visited chat
     (connIndex); the exported `store` is a proxy over the active chat's
     state, so switching chats/projects just re-points it — nothing is
     torn down, and background agents keep streaming into their own state
   - a chat targeting a past session sends switch_session itself after
     connecting, only if the process isn't already on it and isn't
     streaming (per-chat processes are what make mid-run switching safe)
   - send(cmd) / sendPrompt(text) / abort() / setModel() /
     setThinkingLevel() / newSession() / switchSession() act on the active
     chat; chatIndicator()/projectIndicator() expose per-chat
     working/unread status for the sidebar dots
   - handle(conn, ev) is the single switch over incoming event types,
     mutating that chat's reactive state
        │
        ▼
web/src/stores/projects.js — REST client + reactive `projectsStore` for the
   project list and the current project's session (chat) list
        │
        ▼
web/src/App.vue (top-level layout + every globally-mounted overlay)
  ├─ components/sidebar/Sidebar.vue (project list + add/remove, chat history
  │    for current project)
  ├─ components/chat/ — ChatHeader.vue, MessageList.vue, Composer.vue
  │    (header / message column / prompt box; MessageView.vue renders each
  │    message: subagent calls delegate to SubagentView.vue, edit/write
  │    tool calls render as a diff via lib/diff.js)
  ├─ components/popovers/UsagePopover.vue (token/cost totals + sub-agent
  │    breakdown)
  ├─ components/dialogs/AgentsDialog.vue (edit sub-agent definitions,
  │    backed by /api/agents)
  └─ components/dialogs/CommandPalette.vue (Ctrl/Cmd+K fuzzy jump across
       projects + chats)
```

`store` (in `pi.js`, a proxy over the active chat's state) and `projectsStore` (in `projects.js`, the project/session lists) are the reactive sources of truth for the whole UI — there is no other state management. Components read from them directly and call the exported functions to act.

### Server internals (`server/src/main.rs`)

- `AppState` holds `projects: RwLock<HashMap<id, ProjectEntry>>` (persisted metadata) and `running: RwLock<HashMap<"projectId/chatId", RunningProcess>>` (live pi processes, one per chat) separately — a project can exist without any running process, and `ensure_running` lazily spawns/respawns one per chat on demand (each project also gets a `default`-chat warm-up process at boot, mainly so the `get_session_stats` probe teaches the server its session dir before the first page load).
- Per chat: one `mpsc::channel` carries lines from any connected WS client into that chat's pi stdin; one `broadcast::channel` carries every line of that pi process's stdout out to all WS clients on `/ws/{projectId}?chat={chatId}` — this means multiple browser tabs on the same chat stay in sync automatically.
- A lagging client (slow consumer) just skips missed broadcast messages rather than blocking others; the frontend recovers by re-requesting `get_messages` on reconnect (see the `onclose` handler in `pi.js`, which retries the connection after 1.5s).
- If a chat's `pi` child process exits, only that chat's entry is dropped from `running` (next connect respawns it) — the server itself keeps running.
- An idle sweeper reaps processes with zero WS clients and no agent run in flight after a grace period (`IDLE_REAP_SECS`), since per-chat processes would otherwise accumulate without bound; `RunningProcess.streaming` is peeked from pi's own `agent_start`/`agent_settled` events, so a working agent whose tab was closed still runs to completion before becoming reapable.
- When an SSH target is set (`AppState.ssh: RwLock<SshConfig>`, runtime-editable via `/api/ssh` — see below — and persisted to `<data-dir>/ssh.json`), `spawn_child` execs pi over `ssh` instead of spawning it locally (one remote host shared by every project); local-filesystem operations (path validation on add, session-dir listing) are skipped/degrade to empty rather than erroring, since paths are on the remote host. Changing the target via `PUT`/`DELETE /api/ssh` respawns every running chat's pi process against it (`respawn_all`) — the watcher task that removes a dead process from `running` guards the removal with `Arc::ptr_eq` so a respawn's new process (inserted under the same key before the old one is killed) can't be evicted by the old process's own cleanup.
- Windows spawns `pi` via `cmd /C` since it installs as a `.cmd` shim.

### Sub-agent support (pi-mono's `subagent` extension)

pi core has no built-in sub-agent concept; support targets the example
`subagent` extension from pi-mono (one `subagent` tool; single/parallel/chain
dispatch; agents defined as markdown files with YAML frontmatter — `name`,
`description`, `tools`, `model` — whose body is the system prompt). Two
halves:

- **Live monitoring** is pure frontend (per the protocol-boundary rule):
  the extension streams whole-state `details` snapshots (`{ mode, results:
  [{ agent, task, exitCode, messages, usage, model, stopReason,
  errorMessage, step }] }`, `exitCode === -1` = still running) through
  `tool_execution_update` events; `handle()` in `pi.js` stores them on
  `store.toolResults[id].details`, and the shared `subagentDetails()` helper
  (also `pi.js`) is the single detection heuristic used by
  `SubagentView.vue` (inline per-agent cards), `ChatHeader.vue` (running
  count badge) and `UsagePopover.vue` (usage breakdown). Reasoning level is
  encoded in the model string as pi's `provider/id:<thinking>` suffix — the
  extension has no thinkingLevel frontmatter field; `agents.js` owns the
  `splitModelThinking`/`joinModelThinking` codec.
- **Agent definition editing** is the second sanctioned server-side feature
  (alongside provider connect), since agent files are on-disk state pi's RPC
  protocol doesn't expose: `/api/agents` (GET/PUT/DELETE) reads/writes
  user-scope (`~/.pi/agent/agents/*.md`) and project-scope
  (`<project>/.pi/agents/*.md`) files with a hand-rolled frontmatter codec
  (unknown lines round-trip verbatim; unparseable files are listed with
  `parseError` + raw contents for the dialog's raw-edit fallback). Unlike
  provider connect, this **does** work in `--ssh` relay mode — the file ops
  are dual-mode (local `tokio::fs`, or single-invocation ssh commands
  following the `run_git`/`list_remote_dirs` pattern), because the agent
  files live wherever pi runs.

### Frontend internals (`web/src/`)

Layout: `stores/` (reactive state + REST/WS clients), `lib/` (pure helpers, no server state), `components/{chat,sidebar,dialogs,popovers}/` (presentation), with `App.vue`, `main.js`, `style.css`, and `assets/` at the root. Every module and component starts with a header doc-comment stating its responsibility and key exports — read that first when opening a file; the notes below only cover the load-bearing ones.

`stores/`:

- `pi.js` — WebSocket client, one connection + reactive state per visited chat (`connIndex`), with the exported `store` a proxy over the active chat's state. All RPC event handling funnels through `handle(conn, ev)`, for background chats too — their transcripts stay live, so switching to one is instant. The session-path→server-chatId mapping and each project's last-viewed chat persist in localStorage, so a reload re-attaches to the same (possibly still-running) processes.
- `projects.js` — REST client + reactive `projectsStore` (project list, current project's session/chat list). Opening a chat goes through `pi.js`'s per-chat connections; a `switch_session` RPC is only ever sent to a non-streaming process (see `syncOnOpen`).
- `ssh.js` — REST client + reactive `sshStore` for the runtime-editable SSH target (`/api/ssh`, `/api/ssh/test`), same conventions as `projects.js`.
- `auth.js` — `authStore` + the `/ws-auth` WebSocket client for provider connect (see "Provider connect" above).
- `agents.js` — `agentsStore` (ssh.js conventions) for sub-agent definition CRUD via `/api/agents`, plus the `splitModelThinking`/`joinModelThinking` model-string codec (see "Sub-agent support" above).
- `git.js` — `gitStore` for the current project's git branches (`/api/projects/{id}/git/*`): read-only listing + plain checkout.
- `coder.js` — `coderStore` for the Coder cloud-workspace integration (`/api/coder/*`, list/start/stop). Independent of the pi bridge — these are the user's own cloud machines.
- `theme.js` — client-side UI preferences (color profile, font sizes, content width), persisted to localStorage and applied as CSS custom properties on the document root.
- `renameDialog.js` — tiny open/closed store for the rename dialog (pure UI state, deliberately not part of `pi.js`'s per-chat state).
- `confirm.js` — same spirit as `renameDialog.js`: promise-based `confirmDialog()`/`alertDialog()` replacing the browser's native `confirm()`/`alert()`, rendered by `dialogs/ConfirmDialog.vue`.
- `search.js` — REST client + `searchStore` for cross-chat content search (`/api/projects/{id}/search`), consumed by the command palette.

`lib/`:

- `markdown.js` — dependency-free markdown → HTML for assistant text (headings, bold/italic/strikethrough, inline/fenced code, links, nested lists, tables, blockquotes, hr). Fenced code blocks get a static copy button whose click is handled via event delegation in `MessageView.vue` (the HTML lands in `v-html`, so it can't carry a Vue listener directly).
- `diff.js` — detects edit-shaped tool-call arguments (old/new text pair, or a whole-file `write`/`create` call) and computes a line-level LCS diff, collapsed to a few lines of context around each change (`collapseRows`); used by `MessageView.vue`'s diff tool-call rendering, collapsed by default like opencode's tool cards.
- `pageTitle.js` — document title + status-dot favicon (`<project> - <session>`, yellow = streaming / green = idle), wired once from `main.js`.

`components/`:

- `App.vue` (root) — top-level layout: sidebar, active-chat panel (header / messages / composer), and every globally-mounted overlay (dialogs, palette, toasts). Purely presentational — it owns no logic beyond wiring `v-if`s to store flags.
- `chat/ChatHeader.vue` — top chat bar: connection dot, Coder menu, model label, session-name/usage title, running-sub-agent count badge, and the popover trigger buttons. All derived data is computed from `store`.
- `chat/Composer.vue` — the prompt textarea and everything around it. The text and pending images are *per-chat* state (`store.draft` / `store.draftImages` in `pi.js`, the text half persisted to localStorage under `pi-web:drafts` and re-keyed by `rekeyConn`), not local refs, so a half-typed prompt never follows you into another chat and survives a reload. Also: prompt-history recall (ArrowUp/Down on an empty composer, sourced from `store.forkMessages`), image paste, slash-command autocomplete (`BUILTIN_SLASH_COMMANDS` run immediately as RPC calls), model + reasoning-level selects, steer/follow-up queue toggle while streaming, and the git branch select (`chat/GitBranchSelect.vue`). `chat/D20Die.vue` is the pure-fidget d20 next to it.
- `chat/MessageList.vue` — scrollable message column; auto-scrolls to follow the stream unless the user has scrolled up. Mounts `chat/MessageRail.vue`, the floating prompt-index gutter with per-prompt fork buttons, and `chat/FindBar.vue`, the Ctrl/Cmd+F find-in-transcript bar (highlights via the CSS Custom Highlight API over `Range`s rather than injected wrapper nodes, which `v-html` re-renders would clobber; matches inside collapsed `<details>` are skipped).
- `chat/MessageView.vue` — renders a single message's content blocks (`text`, `thinking`, `toolCall`). Tool call results are looked up live from `store.toolResults` by `toolCallId`, not embedded in the message itself. Assistant text blocks render through `lib/markdown.js`; user text renders as plain preformatted text. Sub-agent dispatches (tool name `subagent`, or any result matching `subagentDetails()`) render via `SubagentView.vue`; edit/write tool calls (detected by argument shape in `lib/diff.js`, not a fixed tool-name list) render as a collapsed unified diff instead of the generic raw-args tool block. A hover toolbar on each message offers copy-to-clipboard, and — on user messages, when a fork point exists (paired positionally with `store.forkMessages` by `MessageList.vue`) — edit-and-resend, which is `forkFrom()` (see `pi.js`) plus the prefilled composer it already hands back.
- `chat/SubagentView.vue` — rich inline view of one sub-agent dispatch: per-agent cards with live status/usage/duration, an activity log of the agent's nested tool calls, final output, and error/stderr surfaces; placeholder cards derived from the tool-call args cover the gap before the first streamed snapshot (see "Sub-agent support" above).
- `sidebar/Sidebar.vue` — project list (add/remove, backed by `/api/projects`) and, for the active project, its paginated chat history (backed by `/api/projects/{id}/sessions`), each row with a status dot from `chatIndicator()`/`projectIndicator()` (amber pulse = agent working, green = unread response / blocked dialog in a chat you're not viewing).
- `dialogs/` — modals, all following the ConnectDialog pattern: `ConnectDialog.vue` (provider connect, see above), `AgentsDialog.vue` (sub-agent definition editor over `agents.js`, including the model + reasoning-level selects), `RenameDialog.vue` (session rename via `setSessionName`), `ConfirmDialog.vue` (the styled `confirm()`/`alert()` replacement over `confirm.js`), `ExtensionUIDialog.vue` (pi's blocking `extension_ui_request` dialogs — renders the oldest pending `store.uiRequests[0]` and works through the queue), and `CommandPalette.vue` (Ctrl/Cmd+K fuzzy-jump over projects + non-archived chats, subsequence-matched client-side; at 3+ characters it also appends debounced cross-chat *content* matches from `search.js`; owns its own global hotkey listener).
- `popovers/` — small header-anchored popups: `UsagePopover.vue` (hover-triggered, read-only: session token/cost stats from `get_session_stats` + per-sub-agent breakdown via `subagentDetails()`; per-agent duration is measured client-side from tool-call start/end, and it degrades gracefully when no sub-agent extension is installed), `SshPopover.vue` (click-toggled form on the connection dot for viewing/testing/saving/clearing the SSH target), `ColorProfilePopover.vue` (theme.js preference controls), `CoderMenu.vue` (Coder workspace list with start/stop, polls while open).
- Styling is a single hand-written `style.css` (CSS custom properties for the dark theme) — no CSS framework or utility classes.

### Known gaps (see README "Not yet implemented")

- No chat-history browsing when an SSH target is set (session files live on the remote host; new chats and switching still work, there's just no discovery of past ones).
- No desktop/browser notification when a background chat finishes a turn or blocks on an `extension_ui_request` dialog — the sidebar's per-chat status dots cover it inside the tab, but nothing reaches you outside it.

When working in this area, check whether a change belongs in `pi.js` (protocol/state) versus the `.vue` components (presentation) before touching the server — the server almost never needs to change for frontend-visible features.
