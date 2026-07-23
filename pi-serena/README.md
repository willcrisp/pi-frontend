# pi ↔ Serena bridge extension

A pi extension that connects the [pi coding agent](https://github.com/badlogic/pi-mono)
to [Serena](https://github.com/oraios/serena), an LSP-backed semantic code
toolkit exposed as an MCP server. pi has no built-in MCP support, so this
extension connects to a running Serena instance over HTTP, lists its tools
via the MCP TypeScript SDK, and registers each one as a pi tool.

## Architecture: one persistent Serena instance per project

Earlier versions of this extension spawned a fresh `serena start-mcp-server`
subprocess per pi chat process, synchronously in `before_agent_start`. That
cold-booted Serena and its LSP language servers in the critical path of
every new chat's first prompt (startup latency/failures), and — worse — a
single Serena process has exactly one global "active project"
(`activate_project` tears down the previous project's language server when
switching, confirmed against Serena's own `src/serena/agent.py` and
[oraios/serena#758](https://github.com/oraios/serena/discussions/758)), so
one shared instance can't safely serve concurrent chats on different
projects.

The current design instead runs **one persistent Serena instance per
project**, started once and independently of pi's own process lifecycle
(via `serena-daemon.sh`, by hand or via the `serena@.service` systemd
template), and left running. Every pi chat for that project connects to the
same already-warm instance over HTTP — no per-chat cold start, no
cross-project clobbering.

## What it does

- On `before_agent_start`, reads `<project>/.serena/pi-web-port` (pi's `cwd`
  is always the project path — see `server/src/main.rs`) to find the port a
  persistent Serena instance is listening on for that project. If the file
  doesn't exist, it skips silently (no notification) — the common case for
  a project Serena hasn't been set up for.
- If a port is found, connects with `StreamableHTTPClientTransport` from
  `@modelcontextprotocol/sdk` to `http://localhost:<port>/mcp`.
- Lists Serena's tools (`client.listTools()`) and registers each one via
  `pi.registerTool()`, proxying calls through to `client.callTool()`.
- Registered tools are named `mcp__serena__<toolname>` — this exact prefix
  is load-bearing: pi-web's frontend detects Serena tool calls by name
  prefix (there is no other channel for MCP-server identity) to color them
  distinctly in the UI and feed the monitoring popover.
- Appends an instruction to the system prompt nudging the model to prefer
  Serena's `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`,
  and `search_for_pattern` for initial code exploration, before falling
  back to plain text search or reading whole files.
- Caches the connected client for the lifetime of the pi process so
  repeated turns reuse the connection. If a tool call fails against a
  cached connection (the persistent instance died/restarted since we
  connected), the cached client is dropped so the *next* turn's
  `before_agent_start` retries the connection — not a full retry/backoff
  loop, just "reconnect once, next time."
- If the port file exists but the connection attempt fails (stale port from
  a killed instance, Serena not actually listening), the error is caught, a
  notification is surfaced via `ctx.ui.notify` (when available), and pi
  keeps running without semantic tools — this must not crash pi.

## Prerequisites

Serena must be installed and reachable as `serena` on the `PATH` of the
machine that will run the persistent instance (the pi-web host, or the
remote SSH host in `--ssh` relay mode — same host `pi` itself runs on).
Typical install: run Serena via `uvx` with no persistent install, or
install it locally per Serena's own README and confirm `serena` is on
`PATH`. See `COOKBOOK.md` for the full setup sequence (install, start a
persistent instance per project, index).

## Install

pi auto-loads extensions from `~/.pi/agent/extensions/*.ts` for every
project it runs against. Since pi's `--cwd` is the user's project (not this
repo), install the extension globally rather than per-project:

```sh
mkdir -p ~/.pi/agent/extensions
cp pi-serena/serena.ext.ts ~/.pi/agent/extensions/serena.ext.ts
# or, to track changes in this repo:
ln -s "$(pwd)/pi-serena/serena.ext.ts" ~/.pi/agent/extensions/serena.ext.ts
```

Then, **for each project** you want Serena tools in, start its persistent
instance before opening a pi-web chat against it:

```sh
pi-serena/serena-daemon.sh /path/to/project
```

See `COOKBOOK.md` for details, and this directory's `serena@.service` if
you'd rather have systemd keep it running across reboots/logouts.

## Discovery protocol

`serena-daemon.sh` writes the MCP port it started Serena on to
`<project>/.serena/pi-web-port` (plain text, just the number). The
extension reads that same file every time `before_agent_start` fires (once
per pi process, guarded by `connectAttempted`) to find where to connect.
There is no other coordination between the daemon script and the
extension — if the file is stale (points at a dead instance) or missing,
the extension degrades gracefully rather than erroring.

## Status

**Untested against a real `pi` binary or Serena instance** — this
environment doesn't have either installed. The extension API surface used
here (`pi.registerTool`, `pi.on("before_agent_start", ...)`, the shape of
`ExtensionAPI`/`ctx.ui.notify`) is modeled on the existing
`.pi/extensions/mode-system-prompt.ts` example in this repo, and the MCP
client wiring (`Client`, `StreamableHTTPClientTransport`,
`listTools`/`callTool`) is modeled on the `@modelcontextprotocol/sdk`
TypeScript client API. Things that need verification against the real
binaries/packages before relying on this:

- **The `StreamableHTTPClientTransport` import path and MCP endpoint**:
  confirmed by downloading the actual `@modelcontextprotocol/sdk@1.29.0`
  npm tarball and inspecting its contents (no `pi`/Serena install available
  in this sandbox, but the SDK itself was directly inspectable) —
  `@modelcontextprotocol/sdk/client/streamableHttp.js` does export a class
  named exactly `StreamableHTTPClientTransport`, with constructor signature
  `constructor(url: URL, opts?: StreamableHTTPClientTransportOptions)`. The
  SDK's own example client (`examples/client/simpleStreamableHttp.ts`)
  connects to a server URL ending in `/mcp` (e.g.
  `http://localhost:3000/mcp`). **Not verified**: that Serena's
  `start-mcp-server --transport streamable-http` actually mounts its
  endpoint at `/mcp` specifically — that's Serena's own choice of mount
  path (likely inherited from the Python MCP SDK's default
  `streamable_http_app()`, which does default to `/mcp`, but confirm
  against the installed Serena version if tools fail to connect with a 404).
- **Serena's actual CLI flags for a persistent HTTP-transport instance**:
  `--transport streamable-http --port <PORT> --project <PATH>` is used by
  `serena-daemon.sh` per this change's spec, but hasn't been checked
  against a real `serena start-mcp-server --help`. If the real flag names
  differ, both `serena-daemon.sh` and this extension's assumption about
  which endpoint responds are affected.
- Exact shape of `pi.registerTool()` (parameter names, whether it wants a
  JSON Schema directly, whether `execute` return values need a specific
  content-block format matching pi's tool result type).
- Whether registered tool names actually surface as `mcp__serena__*` in RPC
  events (`tool_execution_start.toolName`) unmodified, or whether pi
  normalizes/sanitizes tool names.
- Whether `before_agent_start` fires once per session or once per turn —
  this extension guards against re-connecting with `connectAttempted`, but
  if it fires per-session-restart rather than per-turn, connection lifetime
  assumptions may need adjusting.
- That `process.cwd()` inside the extension's Node process really does
  equal the project path at the time `before_agent_start` fires (this
  repo's server always spawns pi with `current_dir` set to the project, per
  `server/src/main.rs`, but the extension itself doesn't have direct
  visibility into that beyond trusting Node's own `process.cwd()`).

See pi's extension docs and Serena's own repo for the authoritative APIs:

- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/oraios/serena

## Using it

Once installed, see `COOKBOOK.md` in this directory for indexing projects,
checking the connection, prompting patterns that get the most out of
Serena's tools, and troubleshooting.
