# CLAUDE.md

This file provides guidance when working with code in this repository.

## What this is

`radius`: A minimal dark-themed Vue 3 frontend harness for **OpenCode V2**.

- `web/` — Vue 3 + Vite frontend (plain JS, no TypeScript). Talks directly to an
  OpenCode V2 HTTP REST & Event (SSE) API under `/api/*`. There is no backend of
  our own — the old Rust server was removed in the V2 pivot.
- Vue is the only runtime dependency (plus `@microsoft/fetch-event-source` for the
  authenticated SSE stream). Markdown rendering and diffing are hand-rolled in
  `web/src/lib/` rather than pulled in — keep it that way unless there's a reason.
- No test runner, linter, or formatter is configured. `npm run build` is the only
  check there is.

## Development Commands

```sh
cd web && npm install
npm run dev     # Vite dev server on http://localhost:5173
npm run build   # Production build to web/dist/
```

You also need an OpenCode V2 server to point at:

```sh
npm install -g opencode-ai@next        # ships the `opencode2` binary
opencode2 serve --hostname 127.0.0.1 --port 4096
opencode2 service password             # basic-auth password the server generated
```

Remote servers are reached by tunnelling them to a local port
(`ssh -L 5000:localhost:4096 ALF-UAT.coder`) and pointing the connect dialog at
that port.

### How requests actually reach the server

`web/vite.config.js` installs a **dynamic** proxy, not a fixed `/api` → `:4096`
rule: `/api/<port>/<rest>` is forwarded to `http://127.0.0.1:<port>/<rest>`, and
WebSocket upgrades (the PTY connect stream) are forwarded too. The port is
user-selectable at runtime and persisted in localStorage, defaulting to 4096.

Consequently **every** call must be built from `web/src/stores/ssh.js`:

- `apiBase()` → `/api/<port>/api`, the proxy prefix plus the server's own `/api`.
- `authHeaders()` → the `Authorization: Basic …` header. The OpenAPI declares
  `security: []` on every operation, but an unauthenticated request still 401s.

A fetch that hardcodes `/api/...` or omits `authHeaders()` will fail at runtime
only — this has been the source of real bugs more than once.

## API ground truth

**Read `docs/opencode-api.md` before touching any request/response shape.** It
carries the verified endpoint inventory, the confirmed schemas, the SSE event
catalog, and the known gotchas.

The only source of truth for field shapes is the live target server's own
OpenAPI 3.1 spec at **`/openapi.json`** (unprefixed — *not* `/doc` or
`/api/doc`). Never a packaged SDK or a hosted docs page; both drift from the
server you are actually pointed at. Two `opencode-ai@next` builds with
similar-looking version strings have already diverged on event vocabulary,
prompt body shape, and whether sub-agent dispatch exists at all — so verify
against the specific server in front of you:

```sh
curl -s http://127.0.0.1:4096/openapi.json | jq '.paths | keys'
```

Recurring shape traps, all documented in full in `docs/opencode-api.md`:

- `POST /session/{id}/prompt` body must wrap under `prompt` — a flat `{text}` 400s.
- Agents are addressed by `id`, never display `name`.
- A `question.v2.asked` is a *batch*: `{questions: [...]}`, answered with
  `{answers: string[][]}` keyed by option **label** (options carry no id).
- `fs/list` / `fs/read` take paths relative to `location.directory`.
- V2 has no fs-write, no `/api/config`, no vcs routes, and no session
  delete/rename/fork/share. Compact exists but returns 503 in current builds.

## Architecture

`web/src/stores/*.js` are plain `reactive()` singletons (no Pinia). Components
import them directly.

**Core session flow**

- `opencode.js` (largest module): the OpenCode V2 client — session connect,
  prompts, the SSE stream, model/agent/command/skill catalogs, message and token
  accounting. Also owns two things worth knowing about:
  - *Sub-agent child sessions.* A `subagent` tool call dispatches a child
    session; `childForCall()` / `upsertChild()` stitch the child's transcript to
    the dispatching call across three arrival paths (tool metadata, the child's
    own `session.created`, history backfill), because no single signal is
    reliable on every build.
  - *Per-session activity.* `sessionStatus(id)` drives the sidebar's live dot
    ("working" / "unread"), tracked for every session the stream mentions — not
    just the one on screen — with unread persisted across reloads.
- `projects.js`: session list, active selection, and sidebar grouping by project
  directory. Archiving is client-side only (the server has no project entity).
- `ssh.js`: connection settings, `apiBase()`, `authHeaders()` — see above.

**Interactive gating**

- `permission.js`: queues `permission.v2.asked`, replies once/always/reject,
  and lists/revokes saved always-allow rules.
- `question.js`: queues `question.v2.asked`, steps through the batch, and
  reconciles pending asks from `GET /api/question/request` on every SSE
  (re)connect so an ask dropped while the stream was down doesn't block its
  agent forever. Same FIFO/dialog contract as `permission.js`.

**Server-side reach (all via PTY, because V2 has no write routes)**

- `pty.js`: one-shot remote command / script execution. Runs an interactive `sh`
  and brackets commands with sentinels — a short-lived process exits before the
  create → token → WebSocket handshake finishes and can never be attached.
- `remotefs.js`: read/write/delete text files, layered on `pty.js`. Everything
  moves base64-encoded in both directions; a PTY mangles raw bytes.
- `subagents.js`: create/edit/delete sub-agent definitions. V2 exposes agents
  read-only, so definitions are markdown files under `.opencode/agent/`
  (project) or `~/.config/opencode/agent/` (global) written through `remotefs`.
  **Config is read once at server startup and is not hot-reloaded**, so the
  dialog marks definitions the roster hasn't picked up as "restart to apply".
- `git.js`: branch info per directory, read-only by design (no checkout helper —
  a stray click would mutate a tree an agent may be mid-task in).
- `filesearch.js`: recursive file list for the palette via `fdfind`/`fd`/
  `git ls-files`. `GET /api/fs/list` is single-level, so it can't serve this.

**Client-only UI state** — `theme.js` (color profile, font sizes, content width,
applied as CSS custom properties), `modelfilter.js`, `confirm.js`,
`filepreview.js`, `providers.js` (integrations/credentials via `/api/integration`).

**Components** — `components/chat/` (composer, message list/view, sub-agent
cards, find bar), `components/dialogs/` (connect, permission, question,
sub-agents, providers, command palette), `components/popovers/`,
`components/sidebar/`. Most styling lives in the single global
`web/src/style.css`; newer components add a small `<style scoped>` block on top.
`lib/` holds the dependency-free `markdown.js`, `diff.js`.

## Vestigial from the Pi era — don't treat as live

The repo pivoted from a Rust-server "pi" frontend to a direct OpenCode V2
client, and a few files survived the cut without being wired up:

- `stores/coder.js` + `components/popovers/CoderMenu.vue` — call `/api/coder/*`,
  a route on the deleted Rust server. `CoderMenu.vue` is not mounted anywhere.
- `lib/pageTitle.js` — imports `stores/pi.js`, which no longer exists, and
  nothing imports it (its own comment claims `main.js` wires it; `main.js` does
  not).
- `docs/subagents.md` — a cookbook for pi-mono's sub-agent extension.

## Docs map

| File | Use it for |
|---|---|
| `docs/opencode-api.md` | The API reference. Start here. |
| `docs/subagents-alfuat.md` | Sub-agent ground truth for the real deployment target, claims marked [observed] vs [spec]. |
| `docs/subagents-v2.md` | A *different* build, explicitly **not** the target. Kept only as a record of how far builds diverge. |
| `docs/handover.md` | General project status (snapshot as of an older `main`). |
| `docs/handover-subagents.md` | Pickup point for the inline sub-agent rendering work. |
