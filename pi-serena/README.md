# pi ↔ Serena bridge extension

A pi extension that connects the [pi coding agent](https://github.com/badlogic/pi-mono)
to [Serena](https://github.com/oraios/serena), an LSP-backed semantic code
toolkit exposed as an MCP server. pi has no built-in MCP support, so this
extension spawns Serena over stdio, lists its tools via the MCP TypeScript
SDK, and registers each one as a pi tool.

## What it does

- On `before_agent_start`, spawns `serena start-mcp-server --context
  ide-assistant --project-from-cwd` as a subprocess and connects to it with
  `StdioClientTransport` from `@modelcontextprotocol/sdk`.
- Lists Serena's tools (`client.listTools()`) and registers each one via
  `pi.registerTool()`, proxying calls through to `client.callTool()`.
- Registered tools are named `mcp__serena__<toolname>` — this exact prefix
  is load-bearing: pi-web's frontend detects Serena tool calls by name
  prefix (there is no other channel for MCP-server identity) to color them
  distinctly in the UI and feed the monitoring popover.
- Appends an instruction to the system prompt nudging the model to prefer
  Serena's `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`,
  and `search_for_pattern` for initial code exploration, before falling back
  to plain text search or reading whole files.
- If Serena isn't installed or fails to start, the connection attempt is
  caught, a notification is surfaced via `ctx.ui.notify` (when available),
  and pi keeps running without semantic tools — this must not crash pi,
  since Serena is optional and installed by the user themselves.

## Prerequisites

Serena must be installed and reachable as `serena` on the `PATH` of the
machine that runs `pi` (the pi-web host, or the remote SSH host in `--ssh`
relay mode). Typical install: run Serena via `uvx` with no persistent
install —

```sh
uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context ide-assistant --project-from-cwd
```

— or install it locally per Serena's own README and make sure `serena` is
on `PATH`. Index a project once (`serena project index`) so the semantic
tools have data to work with.

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

Restart (or start) `pi` / the pi-web server; on the first agent turn of
each session it will attempt to connect to Serena and register its tools.

## Status

**Untested against a real `pi` binary or Serena instance** — this
environment doesn't have either installed. The extension API surface used
here (`pi.registerTool`, `pi.on("before_agent_start", ...)`, the shape of
`ExtensionAPI`/`ctx.ui.notify`) is modeled on the existing
`.pi/extensions/mode-system-prompt.ts` example in this repo, and the MCP
client wiring (`Client`, `StdioClientTransport`, `listTools`/`callTool`) is
modeled on the `@modelcontextprotocol/sdk` TypeScript client API. Things
that need verification against the real binaries before relying on this:

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
- Serena's actual CLI flags/behavior for `start-mcp-server` in the installed
  version.

See pi's extension docs and Serena's own repo for the authoritative APIs:

- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/oraios/serena
