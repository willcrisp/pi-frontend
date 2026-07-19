# pi-web

Minimal dark-themed web frontend for the [pi coding agent](https://github.com/badlogic/pi-mono).

- `server/` — tiny Rust (axum) server. Spawns `pi --mode rpc` and transparently
  bridges its newline-delimited JSON stdio to a WebSocket at `/ws`. It does not
  parse the protocol, so it stays compatible as pi evolves. Also serves the
  built frontend.
- `web/` — Vue 3 + Vite frontend (plain JS, Vue is the only runtime
  dependency). The browser speaks pi's RPC protocol directly over the
  WebSocket: streaming deltas, tool calls with live output, history hydration
  via `get_messages`.

## Run

```sh
# one-time: build the frontend
cd web && npm install && npm run build

# run the server (from the repo root)
cd server && cargo run --release -- --cwd C:\\Users\\crispy\\AppData\\Local\\pi-node\\current
```

Open http://127.0.0.1:3210.

Server flags:

| Flag | Default | |
|---|---|---|
| `--port N` | `3210` | HTTP/WS port (binds 127.0.0.1 only) |
| `--cwd DIR` | `.` | Working directory pi runs in |
| `--pi-bin PATH` | `pi` | pi executable |
| `--web-dir DIR` | `web/dist` | Built frontend to serve |
| `-- <args>` | | Everything after `--` is passed to pi (e.g. `-- --model sonnet --continue`) |

## Dev

Run the Rust server, then in a second terminal:

```sh
cd web && npm run dev
```

Vite serves the UI on :5173 with hot reload and proxies `/ws` to the Rust
server on :3210.

## Not yet implemented

- Markdown rendering of assistant text (plain text for now)
- `extension_ui_request` dialogs (confirm/select/input from extensions)
- Session switching / model picker UI
- Images in prompts
