# pi-web

Minimal dark-themed web frontend for the [pi coding agent](https://github.com/badlogic/pi-mono),
with a sidebar for switching between projects and each project's chat history.

- `server/` — Rust (axum) server. Manages a pool of `pi --mode rpc` child
  processes, one per project, and transparently bridges each one's
  newline-delimited JSON stdio to WebSocket clients at `/ws/{projectId}`. It
  doesn't parse the protocol (so it stays compatible as pi evolves) beyond one
  small exception: it peeks at `get_session_stats` responses to learn where a
  project's session history lives on disk. Projects run concurrently — an
  agent keeps working in a project you're not currently viewing — and are
  added/removed via the `/api/projects` REST endpoints from the sidebar,
  persisted to `<data-dir>/projects.json`. With `--ssh`, every project's pi
  process runs on one remote host over SSH instead of locally (see "Remote
  setup" below). Also serves the built frontend.
- `web/` — Vue 3 + Vite frontend (plain JS, Vue is the only runtime
  dependency). The browser speaks pi's RPC protocol directly over the
  WebSocket: streaming deltas, tool calls with live output, history hydration
  via `get_messages`. The sidebar lists known projects and, for the active
  one, its past chats (via `switch_session`/`new_session`). Assistant text
  renders as markdown; prompts can include pasted images; edit/write tool
  calls render as a collapsed red/green diff instead of raw JSON; blocking
  `extension_ui_request` dialogs (confirm/select/input/editor) and
  fire-and-forget notifications render inline; every user message can be
  copied or edited-and-resent (forks the chat from that point); and
  Ctrl/Cmd+K opens a fuzzy command palette to jump between projects and chats.

## Run

Prerequisites: Rust (`cargo`), Node.js, and `pi` installed and importable
(check with `pi --version`; on this machine `pi` is a shim in
`C:\Users\crispy\AppData\Local\pi-node\current`, already on `PATH`).

```sh
# one-time: build the frontend
cd web && npm install && npm run build

# run the server (from the repo root), pointing --cwd at the project
# you want pi to work on — NOT at pi's own install directory
cd server && cargo run --release -- --cwd C:\path\to\your\project
```

Open http://127.0.0.1:3210. `--cwd` only seeds the first project on the very
first run (so the old single-project workflow still works out of the box);
after that, add/remove projects from the sidebar and the list persists across
restarts.

If `pi` isn't on `PATH`, pass its full path explicitly instead:

```sh
cargo run --release -- --cwd C:\path\to\your\project --pi-bin "C:\Users\crispy\AppData\Local\pi-node\current\pi.cmd"
```

Server flags:

| Flag | Default | |
|---|---|---|
| `--port N` | `3210` | HTTP/WS port (binds 127.0.0.1 only) |
| `--cwd DIR` | `.` | Working directory for the seed project on first run, local or on the remote host (`--ssh` mode) |
| `--pi-bin PATH` | `pi` | pi executable, local or remote |
| `--web-dir DIR` | `web/dist` | Built frontend to serve |
| `--data-dir DIR` | `~/.pi-web` | Where `projects.json` is persisted |
| `--ssh user@host` | | Relay mode: exec pi for every project over SSH on one remote machine instead of spawning it locally |
| `--ssh-identity PATH` | | Private key for `--ssh` (omit if the remote uses Tailscale SSH / an agent) |
| `--ssh-port N` | `22` | SSH port for `--ssh` |
| `-- <args>` | | Everything after `--` is passed to pi for every project (e.g. `-- --model sonnet`) |

## Remote setup: thin client on Railway, pi on your own machine

If you want to drive pi from your phone without keeping a laptop open, run
this thin client (frontend + bridge server) as a Railway service reachable
over [Tailscale](https://tailscale.com/), and have the bridge server SSH
into your actual dev machine — which also runs pi and holds your code —
over the tailnet. Nothing here binds to the public internet: the server
still only listens on `127.0.0.1`, and Tailscale's userspace networking
mode proxies inbound tailnet traffic to that loopback port from inside the
container. Railway doesn't grant containers a `/dev/net/tun` device, which
is why userspace networking (not a full TUN-based Tailscale node) is used —
see `entrypoint.sh`.

**On your dev machine** (wherever pi and your code actually live):

1. Install Tailscale and join the same tailnet: `tailscale up`.
2. Enable Tailscale SSH so no key management is needed:
   `tailscale up --ssh`. (Alternatively, use regular `sshd` with a
   dedicated keypair — see `SSH_PRIVATE_KEY` below.)
3. Make sure `pi` is installed and on `PATH` for the SSH user, and that
   your project checkout exists at some path you'll pass as `REMOTE_CWD`.

**On Railway** (this repo, deployed via the included `Dockerfile`):

1. Create a Tailscale [auth key](https://login.tailscale.com/admin/settings/keys)
   — mark it reusable and ephemeral, so redeploys don't pile up stale
   offline nodes in your tailnet.
2. Set these service variables:

   | Variable | Example | |
   |---|---|---|
   | `TS_AUTHKEY` | `tskey-auth-...` | from step 1 |
   | `SSH_TARGET` | `you@dev-machine.your-tailnet.ts.net` | your dev machine's Tailscale SSH hostname |
   | `REMOTE_CWD` | `/home/you/projects/myapp` | project directory on the dev machine |
   | `SSH_PRIVATE_KEY` | *(optional)* | only needed if not using Tailscale SSH |
   | `TS_HOSTNAME` | *(optional)* | Tailscale node name for this Railway service |
   | `PI_EXTRA_ARGS` | *(optional)* | e.g. `--model sonnet --continue` |

3. Deploy. Do **not** add a public Railway domain/port for this service —
   there's no auth in front of it, so it should only ever be reachable via
   the tailnet.
4. From your phone, install Tailscale, join the same tailnet, and open
   `http://<railway-service-tailscale-name>:3210`.

## Dev

Run the Rust server, then in a second terminal:

```sh
cd web && npm run dev
```

Vite serves the UI on :5173 with hot reload and proxies `/ws` and `/api` to
the Rust server on :3210.

## Not yet implemented

- Idle eviction of project processes (every added project's `pi` process runs
  until removed or the server restarts)
- Chat-history browsing in `--ssh` mode (session files live on the remote
  host, so the sidebar's history list is always empty there for now — new
  chats and switching still work, there's just no discovery of past ones)
- Desktop/browser notifications when a background project needs attention
  (finishes a turn, or blocks on an `extension_ui_request` dialog) while
  you're viewing a different project

## Sub-agents

pi-web has first-class UI support for pi-mono's example `subagent`
extension (single/parallel/chain dispatch of markdown-defined agents):

- **Live monitoring** — a sub-agent dispatch renders as rich inline cards
  in the chat instead of a generic tool block: per-agent status, model,
  task, live token/cost/turn counts, an activity log of the agent's own
  tool calls, and its final output. A badge in the header counts running
  sub-agents and jumps to the active call on click, and the usage popover
  (bar-chart icon) shows a per-agent usage breakdown next to the session
  totals from `get_session_stats`.
- **Agent editor** — the people icon in the header opens a dialog for
  creating/editing/deleting agent definitions in user scope
  (`~/.pi/agent/agents/*.md`) and project scope (`<project>/.pi/agents/*.md`),
  including each agent's model and reasoning level. Reasoning is stored as
  pi's `provider/id:<thinking>` model-string suffix, since the extension
  has no dedicated frontmatter field for it. This works in `--ssh` relay
  mode too — the files are read/written on the remote host, where pi
  actually runs.

pi core has no built-in concept of sub-agents (by design, see its docs),
so there's nothing to monitor unless a sub-agent extension is installed
in *your* `pi` directory (not this repo). Detection is heuristic: any
tool call whose result contains `details.results` (an array of `{ agent,
model, usage, stopReason, errorMessage }` objects) is treated as a
sub-agent dispatch, matching the shape produced by pi-mono's own example
`subagent` extension. Per-agent duration is measured client-side
(start/end of the tool call), since that extension doesn't report
elapsed time itself.

To install that example extension into your `~/.pi` config (run from a
checkout of `badlogic/pi-mono`):

```sh
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" \
  ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" \
  ~/.pi/agent/extensions/subagent/agents.ts

mkdir -p ~/.pi/agent/agents
cp packages/coding-agent/examples/extensions/subagent/agents/*.md ~/.pi/agent/agents/
```

The agent `.md` files are copied rather than symlinked so that edits made
from pi-web's agent editor land in your config, not in the pi-mono
checkout.

If you use a different sub-agent extension (or your own), the popover
will still pick it up automatically as long as its tool result includes
`details.results[].usage` with `{ input, output, cost }` fields — no
frontend changes needed.

Without any of that installed, the popover just shows session totals and
"no sub-agents used this session" — it degrades gracefully, it just won't
have anything sub-agent-shaped to display.
