# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

pi-web: a minimal dark-themed web frontend for the [pi coding agent](https://github.com/badlogic/pi-mono). It's a two-part system:

- `server/` — a tiny Rust (axum) server. It spawns `pi --mode rpc` as a child process and transparently bridges its newline-delimited JSON stdio to a WebSocket at `/ws`. It does **not** parse pi's RPC protocol at all — it's a dumb byte-for-line pipe, which is what keeps it compatible as pi evolves. It also serves the built frontend as static files.
- `web/` — a Vue 3 + Vite frontend (plain JS, no TypeScript; Vue is the only runtime dependency). The browser speaks pi's RPC protocol directly over the WebSocket — the server has no involvement in interpreting messages.

There is no root `package.json`; `server/` and `web/` are independent projects (Cargo and npm respectively) built and run separately.

## Commands

Build the frontend (one-time or after frontend changes), then run the server:

```sh
cd web && npm install && npm run build
cd server && cargo run --release -- --cwd path/to/your/project
```

Open http://127.0.0.1:3210.

Frontend dev loop (hot reload, run alongside the server):

```sh
cd server && cargo run --release -- --cwd path/to/your/project   # terminal 1
cd web && npm run dev                                             # terminal 2
```

Vite serves the UI on :5173 and proxies `/ws` to the Rust server on :3210 (see `web/vite.config.js`).

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
| `--cwd DIR` | `.` | Working directory pi runs in |
| `--pi-bin PATH` | `pi` | pi executable |
| `--web-dir DIR` | `web/dist` | Built frontend to serve |
| `-- <args>` | | Everything after `--` is passed through to the `pi` child process (e.g. `-- --model sonnet --continue`) |

## Architecture

### The protocol boundary is in the browser, not the server

The single most important thing to know: `server/src/main.rs` never deserializes the JSON it shuttles between `pi`'s stdio and the WebSocket. All protocol knowledge — every RPC command name, every event type, every payload shape — lives in `web/src/pi.js`. When adding support for a new pi RPC command or event, there is nothing to change server-side; do it entirely in `pi.js` (and the Vue components that consume the store).

### Data flow

```
pi child process (stdin/stdout, newline-delimited JSON)
        │
   server/src/main.rs
   - mpsc channel:      WS client -> pi stdin
   - broadcast channel: pi stdout -> all WS clients
        │  (WebSocket, one JSON object per text frame)
        ▼
web/src/pi.js
   - connect() opens the WS, sends get_state / get_messages /
     get_available_models / get_session_stats on open
   - send(cmd) / sendPrompt(text) / abort() / setModel() /
     setThinkingLevel() write RPC commands
   - handle(ev) is the single switch over incoming event types,
     mutating the reactive `store` object
        │
        ▼
web/src/App.vue (composer, header, model/thinking selects)
  ├─ MessageView.vue (renders one message: text / thinking / toolCall blocks)
  └─ UsagePopover.vue (session token/cost totals + sub-agent breakdown)
```

`store` (in `pi.js`) is the single reactive source of truth for the whole UI — there is no other state management. Components read from it directly and call the exported functions (`sendPrompt`, `abort`, `setModel`, `setThinkingLevel`) to act.

### Server internals (`server/src/main.rs`)

- One `mpsc::channel` carries lines from any connected WS client into pi's stdin.
- One `broadcast::channel` carries every line of pi's stdout out to all connected WS clients — this means multiple browser tabs stay in sync automatically.
- A lagging client (slow consumer) just skips missed broadcast messages rather than blocking others; the frontend recovers by re-requesting `get_messages` on reconnect (see `ws.onclose` in `pi.js`, which retries the connection after 1.5s).
- If the `pi` child process exits, the server exits too (`std::process::exit(1)`) — there's no supervisor/restart logic, by design.
- Windows spawns `pi` via `cmd /C` since it installs as a `.cmd` shim.

### Frontend internals (`web/src/`)

- `pi.js` — WebSocket client + the reactive `store`. All RPC event handling funnels through `handle(ev)`.
- `App.vue` — top-level layout: header (connection dot, model, session name, usage popover), scrollable message list, composer (textarea + send/stop), model/thinking-level selects. Auto-scrolls the message pane unless the user has scrolled up.
- `MessageView.vue` — renders a single message's content blocks (`text`, `thinking`, `toolCall`). Tool call results are looked up live from `store.toolResults` by `toolCallId`, not embedded in the message itself.
- `UsagePopover.vue` — session-level token/cost stats from `get_session_stats`, plus a **heuristic** sub-agent breakdown: any tool result whose `details.results` is an array of `{ agent, model, usage, stopReason, errorMessage }` is treated as a sub-agent dispatch (the shape produced by pi-mono's example `subagent` extension). Per-agent duration is measured client-side from tool-call start/end, since that extension doesn't report elapsed time itself. This degrades gracefully to "no sub-agents used this session" when no such extension is installed — see the README's "TODO: pi-side setup for the token usage popover" section for how to wire one up in a local `pi` config.
- Styling is a single hand-written `style.css` (CSS custom properties for the dark theme) — no CSS framework or utility classes.

### Known gaps (see README "Not yet implemented")

- No markdown rendering of assistant text (plain text only).
- No handling of `extension_ui_request` dialogs (confirm/select/input from extensions).
- No session-switching UI.
- No image support in prompts.

When working in this area, check whether a change belongs in `pi.js` (protocol/state) versus the `.vue` components (presentation) before touching the server — the server almost never needs to change for frontend-visible features.
