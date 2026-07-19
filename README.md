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
cd server && cargo run --release -- --cwd path/to/your/project
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
- Session switching UI
- Images in prompts

## TODO: pi-side setup for the token usage popover

The bar-chart icon in the header shows a hover popover with token/cost
totals (via pi's `get_session_stats` RPC command) and a per-sub-agent
breakdown. The session totals work out of the box against any reasonably
current `pi` build. The sub-agent breakdown does **not** — pi core has no
built-in concept of sub-agents (by design, see its docs), so there's
nothing to show unless a sub-agent extension is installed in *your* `pi`
directory (not this repo).

The frontend detects sub-agent runs heuristically: any tool call whose
result contains `details.results` (an array of `{ agent, model, usage,
stopReason, errorMessage }` objects) is treated as a sub-agent dispatch,
matching the shape produced by pi-mono's own example `subagent` extension.
Per-agent duration is measured client-side (start/end of the tool call),
since that extension doesn't report elapsed time itself.

To get the breakdown populated, install that example extension into your
`~/.pi` config (run from a checkout of `badlogic/pi-mono`):

```sh
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" \
  ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" \
  ~/.pi/agent/extensions/subagent/agents.ts

mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done
```

If you use a different sub-agent extension (or your own), the popover
will still pick it up automatically as long as its tool result includes
`details.results[].usage` with `{ input, output, cost }` fields — no
frontend changes needed.

Without any of that installed, the popover just shows session totals and
"no sub-agents used this session" — it degrades gracefully, it just won't
have anything sub-agent-shaped to display.
