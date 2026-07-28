# CLAUDE.md

This file provides guidance when working with code in this repository.

## What this is

`radius`: A minimal dark-themed Vue 3 frontend harness for **OpenCode V2**.

- Vue 3 + Vite frontend (plain JS, no TypeScript). Talks directly to an
  OpenCode V2 HTTP REST & Event (SSE) API under `/api/*`. There is no backend of
  our own — the old Rust server was removed in the V2 pivot, and the frontend
  used to live under `web/` before it became the whole repo.
- Vue is the only runtime dependency (plus `@microsoft/fetch-event-source` for the
  authenticated SSE stream). Markdown rendering and diffing are hand-rolled in
  `src/lib/` rather than pulled in — keep it that way unless there's a reason.
- No linter or formatter is configured. The checks are `npm run build` (a broken
  import or bad template is otherwise a runtime-only failure) and `npm test`, a
  small Playwright suite over the composer. Run both before calling a change done.

## Where to make a change

Files are kept small and single-purpose so a change lands in one of them. Start
here rather than grepping the whole tree:

| To change… | Edit |
|---|---|
| an SSE event's effect | one entry in `HANDLERS`, `stores/opencode/events.js` |
| the request/response shape of a server call | the store that owns the route; the transport is `lib/api.js` |
| how a prompt is sent, or its body shape | `stores/opencode/transport.js` |
| a component's appearance | its partial in `src/styles/`, or its `<style scoped>` |
| composer input, attachments, or the `/` and `@` menus | the matching `use*` in `src/composables/` |
| what the sidebar dot shows | `stores/opencode/activity.js` |
| sub-agent card behaviour | `stores/opencode/children.js` + `components/chat/SubagentView.vue` |
| a persisted preference | the owning store, via `lib/storage.js` |

## Development Commands

```sh
npm install
npm run dev     # Vite dev server on http://localhost:5173
npm run build   # Production build to dist/
npm test        # Playwright composer tests (starts its own servers)
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

### Testing

`npm test` runs Playwright against the real UI. It needs no running OpenCode
server and no setup: `playwright.config.js` starts both the Vite dev server
and `test/mock-opencode.js`, a stand-in implementing just enough of the V2
HttpApi to boot the frontend (health, the four catalogs, a session list, an
empty transcript, an SSE stream held open).

First run on a fresh machine needs a browser: `npx playwright install chromium`.
Where a sandbox or CI image already ships a Chromium that doesn't match this
package's build number, point at it instead — `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm test`.

The suite covers `src/composables/` — the composer's autosize, attachments,
the `/` and `@` menus, and the model picker — because that is the most stateful
UI in the repo. It is a smoke suite, not a regression net for everything:

- Prefer driving the real component to stubbing at the network layer. If a test
  needs a route the mock lacks, add it to `mock-opencode.js`.
- A test asserting a specific past bug should say so, so it isn't "simplified"
  away later — see the Escape case in `test/mentions.spec.js`.
- Anything reached over PTY (`filesearch.js`, `git.js`, `remotefs.js`) has no
  mock; seed the store's localStorage cache instead, as `mentions.spec.js` does.

### How requests actually reach the server

`vite.config.js` installs a **dynamic** proxy, not a fixed `/api` → `:4096`
rule: `/api/<port>/<rest>` is forwarded to `http://127.0.0.1:<port>/<rest>`, and
WebSocket upgrades (the PTY connect stream) are forwarded too. The port is
user-selectable at runtime and persisted in localStorage, defaulting to 4096.

Consequently every call needs the proxy prefix (`apiBase()` →`/api/<port>/api`)
and the `Authorization: Basic …` header (`authHeaders()`) — the OpenAPI declares
`security: []` on every operation, but an unauthenticated request still 401s. A
fetch that hardcodes `/api/...` or omits the header fails at runtime only, and
that was the source of real bugs more than once.

**So don't call `fetch` directly — use `src/lib/api.js`.** It applies both,
and takes server-relative paths:

```js
import { apiGet, apiPost, getJSON, unwrap, errorMessage } from "../lib/api.js";

const res = await apiGet(`/session/${id}/message`);   // Response; you check .ok
const list = unwrap(await res.json());                // {data:[…]} envelope off
await apiPost(`/session/${id}/agent`, { agent });     // JSON body + headers
const info = await getJSON(`/session/${id}`);         // parsed, or null on failure
```

The one legitimate exception is `pty.js`'s WebSocket URL, which can't go through
a fetch wrapper and says so in a comment.

Persisted UI state goes through `src/lib/storage.js` (`readJSON`/`writeJSON`/
`readArray`/`readNumber`/`readString`/`writeString`) rather than `localStorage`
directly — they never throw, which matters because a quota error in private mode
would otherwise take down whatever was mid-write.

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

- `POST /session/{id}/prompt` takes a `delivery: "steer" | "queue"` (defaults to
  `steer`) — that's the steering mechanism. Its body is flat on some builds and
  wrapped under `prompt` on others; `postPrompt()` in
  `stores/opencode/transport.js` detects which, and that file is the only place
  this route is called from.
- Agents are addressed by `id`, never display `name`.
- A `question.v2.asked` is a *batch*: `{questions: [...]}`, answered with
  `{answers: string[][]}` keyed by option **label** (options carry no id).
- `fs/list` / `fs/read` take paths relative to `location.directory`.
- V2 has no fs-write, no `/api/config`, no vcs routes, and no session
  delete/rename/fork/share. Compact exists but returns 503 in current builds.

## Architecture

`src/stores/*.js` are plain `reactive()` singletons (no Pinia). Components
import them directly.

**Core session flow — `stores/opencode/`**

The OpenCode V2 client. `stores/opencode.js` is a **facade** that re-exports the
public surface; components import from there, so the internals can move without
touching 20 call sites. Another store module should import the specific file it
needs. Modules, in dependency order (they run strictly downward — there are no
cycles, and introducing one is a design error, not a detail; if two modules need
each other, the shared part belongs lower down):

| Module | Owns |
|---|---|
| `state.js` | the `reactive()` store; imports no sibling, so anything may use it |
| `transport.js` | `POST /session/:id/prompt` — delivery modes, flat-vs-wrapped body |
| `children.js` | linking a `subagent` call to the child session it dispatched |
| `models.js` | model + reasoning-effort selection and its persistence |
| `context.js` | token/context accounting (local estimate vs server truth) |
| `steer.js` | prompts admitted into a run already in flight |
| `activity.js` | per-session running/unread — the sidebar dot |
| `messages.js` | transcript load, REST→view normalization, sub-agent backfill |
| `prompt.js` | sending a prompt that starts a turn |
| `catalog.js` | model/agent/command/skill lists |
| `session.js` | revert, interrupt, agent switch, compact |
| `events.js` | the SSE reducer — one handler per event type |
| `stream.js` | the SSE subscription and `initOpenCode()` |

Three behaviours are worth knowing before changing any of them:

- *Sub-agent child sessions* (`children.js`). A `subagent` tool call dispatches a
  child session; the link between call and child arrives by up to three routes
  (tool metadata, the child's own `session.created`, history backfill) because no
  single signal is reliable on every build. All three feed `upsertChild()`.
- *Steering* (`steer.js`). `sendSteer()` posts with `delivery: "steer"` into a run
  that is already going; the agent reads it at its next turn. The server keeps an
  admitted input out of the message list until it promotes it, so `pendingSteers`
  tracks the gap and the composer's steer pill counts it.
- *Per-session activity* (`activity.js`). `sessionStatus(id)` drives the sidebar's
  live dot ("working" / "unread"), tracked for every session the stream mentions
  — not just the one on screen — with unread persisted across reloads.

**Adding or changing an SSE event** is a single entry in the `HANDLERS` table in
`events.js`, keyed by event type. Each handler gets
`{ type, props, child, messages, sessionID }`; **check `child`** — a non-null
`child` means the event belongs to a sub-agent and must not touch session-wide
state (streaming flag, model selection, usage), and write to `messages` rather
than `opencodeStore.messages` so a child's transcript lands on the child.

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
`components/sidebar/`.

**Composables** — `src/composables/` holds the composer's parts:
`useAttachments` (paste/drop/picker, thumbnails, image markup), `useAutosize`,
`useSlashCommands` (the `/query` menu), `useFileMentions` (the `@path` menu),
`useModelPicker` (agent/model/reasoning selects and their Ctrl/Cmd+arrow
shortcuts), and `useListMenu` — the keyboard behaviour the two autocomplete
menus share. `Composer.vue` is wiring plus the template.

Composables return refs; **destructure them at the top of `<script setup>`** so
the template auto-unwraps (`attachments`, not `files.attachments.value`).

**Shared helpers** — `lib/api.js` (every server call; see above), `lib/storage.js`
(every persisted preference), plus the dependency-free `markdown.js`, `diff.js`,
`fuzzy.js`.

**Styles** — `src/style.css` is an ordered list of `@import`s; the rules
live in `src/styles/*.css`, one partial per feature, named after the
component it styles. **The import order is load-bearing**: these are flat
global rules with many equal-specificity selectors, so ties resolve by source
order. Edit the partial that owns the component; a genuinely new component gets
a new partial imported at the *end* of the list. Self-contained components are
better off with a `<style scoped>` block, which wins over all of it.

## Docs map

| File | Use it for |
|---|---|
| `docs/opencode-api.md` | The API reference. Start here. |
| `docs/subagents-alfuat.md` | Sub-agent ground truth for the real deployment target, claims marked [observed] vs [spec]. |
| `docs/subagents-v2.md` | A *different* build, explicitly **not** the target. Kept only as a record of how far builds diverge. |
| `docs/handover.md` | General project status (snapshot as of an older `main`). |
| `docs/handover-subagents.md` | Pickup point for the inline sub-agent rendering work. |

⚠️ Both handover docs predate the store/style split, so the file paths in them
are stale (they describe a single `stores/opencode.js` and a single
`style.css`). Their *reasoning* still holds; treat this file as the map.
