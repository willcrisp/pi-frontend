# OpenCode V2 HTTP API reference (for this frontend)

This frontend (`web/src/stores/opencode.js`, `projects.js`, `ssh.js`) talks
directly to an OpenCode V2 server's HTTP/SSE API — there is no server-side
component in this repo translating or documenting the protocol, so getting
field names wrong here is a silent runtime bug, not a compile error.

## The only source of truth: the live server's own `/doc`

**Do not trust any packaged SDK, prose docs, or this file's field-shape
notes over the actual server you're pointed at.** OpenCode's HTTP server
generates its OpenAPI 3.1 spec live from its own route definitions
(`hono-openapi`/`describeRoute`), and serves it at `/doc` on whatever port
`opencode serve` is running — e.g. `http://127.0.0.1:4096/doc`. That is
ground truth for that specific server build. Anything else (a versioned npm
package, this doc, a hosted docs page) can drift out from under a given
server and produce silent runtime bugs, not compile errors — verify against
`/doc` before relying on a field name.

```sh
# direct to the opencode server (adjust port):
curl -s http://127.0.0.1:4096/doc | jq '.components.schemas.SessionV2Info'
curl -s http://127.0.0.1:4096/doc | jq '.paths | keys'

# through this repo's dev setup, from the browser/vite side, apiBase() adds
# its own /api prefix on top of the proxy prefix — see ssh.js — so the doc
# route (if the server exposes it under the same prefix) is reachable at
# /api/<port>/api/doc during `npm run dev`.
```

If no server is reachable to check against (e.g. this sandbox has none
running), say so explicitly rather than asserting a field shape from memory
or from a package that may not match. `https://v2.opencode.ai/docs/api/`
and the DeepWiki mirrors return HTTP 403 through this environment's fetch
tooling (Cloudflare block on the agent proxy) — don't waste time retrying
those; they're not a substitute for `/doc` on the real server anyway, since
they can't reflect the exact build you're targeting.

## Which route surface this frontend actually calls

`apiBase()` (`web/src/stores/ssh.js`) resolves to `/api/<port>/api` — after
the Vite dev proxy strips the `/api/<port>` prefix, requests land on the
real server at `/api/...`. Confirm any endpoint you're about to use is
actually under that `/api`-prefixed surface in the target server's own
`/doc` output — OpenCode has historically exposed more than one HttpApi
surface with similarly-shaped-but-different types mounted at different
prefixes, so a field or path that "looks right" from a doc, package, or
memory of a different surface can silently be the wrong one.

### Known gotcha (verify against your server's `/doc` before trusting)

The last time this was checked, the session objects returned by this
frontend's `GET /api/session` (`SessionsResponse.data: SessionV2Info[]`) did
**not** have a flat `directory` field — the project root instead lived at
`session.location.directory` (`location: { directory, workspaceID? }`).
`projects.js#fetchSessions` reads `s.location.directory` accordingly. If
that's wrong for the server you're pointed at, `curl .../doc | jq
'.components.schemas.SessionV2Info'` (or whatever the live schema calls it)
will show the real shape — trust that over this paragraph.

Two more, confirmed against a live server via HAR capture (2026-07-24):

- **Agents are addressed by `id`, not `name`.** `GET /api/agent` returns
  `{ id: "build", name: "Build", ... }`; every place an agent is sent
  (`POST /session` body, `POST /session/:id/agent`) must use the lowercase
  `id`. Sending the display name fails with `Agent not found: "Build"` —
  and see the next point for why that failure used to be invisible.
- **The SSE stream uses a `session.execution.*` lifecycle**, not just the
  classic `message.*`/`session.idle` vocabulary. Observed events:
  `server.connected`, `session.input.admitted`, `session.execution.started`,
  `session.execution.failed` (payload `{ sessionID, error: { type, message } }`),
  `session.model.selected`, `pty.created`/`pty.exited`/`pty.deleted`.
  Envelope is `{ id, type, data, created?, durable?, location? }`.
  `opencode.js#handleServerEvent` must handle execution completion/failure
  or the UI spins on "thinking" forever with no error shown.

## What this frontend currently reads from each response

Recorded here as "what the code assumes today," not as a schema — confirm
against `/doc` before changing any of it:

- **`GET /api/session`** (`projects.js#fetchSessions`) — per session:
  `id`, `title`, `time.updated`/`time.created`, `location.directory` (see
  gotcha above). Mapped to `{ id, title, updatedAt, directory }`, sorted
  most-recently-updated first; `groupSessionsByDirectory()` then groups by
  `directory` for the sidebar (`Sidebar.vue`), one collapsible section per
  project root, most recently active first.
- **`GET /api/model`** (`opencode.js#loadModels`) — per model: `id`,
  `providerID`, `name`, `limit.context`, and optionally `variants`
  (reasoning-effort presets; the composer's reasoning `<select>` shows its
  keys, and the chosen key is sent as `variant` inside the Model.Ref —
  **UNVERIFIED against a live `/doc`**, both field name and ref shape).
  Mapped to `{ providerID, modelID: id, label: name || providerID/id,
  contextLimit: limit.context, variants }`.
  `Composer.vue`'s `modelsByProvider` groups the model `<select>`'s options
  by `providerID` into `<optgroup>`s.
- **`GET /api/agent`**, **`GET /api/command`** — consumed close to as-is;
  see the inline comments in `opencode.js#loadAgents`/`loadCommands`.

## Endpoints this frontend calls

| Method | Path | Used by |
|---|---|---|
| GET | `/api/session` | `projects.js#fetchSessions` |
| POST | `/api/session` | `projects.js#startNewChat` — body may include `agent`, `model` (Model.Ref), and for "new project" a root directory: tries `{ directory }`, falls back to `{ location: { directory } }` on a non-2xx (**UNVERIFIED** — check the create body's real field against `/doc`) |
| DELETE | `/api/session/{sessionID}` | `projects.js#removeSession` |
| GET | `/api/session/{sessionID}/message` | `opencode.js#refreshActiveMessages` |
| POST | `/api/session/{sessionID}/prompt` | `opencode.js#sendPrompt` |
| POST | `/api/session/{sessionID}/interrupt` | `opencode.js#abortSession` |
| POST | `/api/session/{sessionID}/model` | `opencode.js#setModel` |
| POST | `/api/session/{sessionID}/agent` | `opencode.js#setAgent` |
| GET | `/api/model` | `opencode.js#loadModels` |
| GET | `/api/agent` | `opencode.js#loadAgents` |
| GET | `/api/command` | `opencode.js#loadCommands` |
| GET | `/api/skill` | `opencode.js#loadSkills` (optional; empty list if the route is missing) |
| POST | `/api/session/{sessionID}/command` | `opencode.js#runCommand` — `{ command, arguments }`; on non-2xx falls back to sending the raw `/name args` as a plain prompt (**UNVERIFIED** — check route + body against `/doc`) |
| GET | `/api/event` (SSE) | `opencode.js#setupEventStream` |
| GET | `/health` | `opencode.js#initOpenCode` |

For anything not in this table (session fork/revert/compact/share, provider
listing/auth, PTY, permissions, `fs/*`, project listing, etc.) — check the
target server's own `/doc` for whether it exists and what it's shaped like,
rather than assuming from this list.

## Project grouping: no separate project-list fetch (yet)

A `GET /project`-style listing (if the target server exposes one) may return
richer project metadata (a user-set `name`, icon, etc.) than sessions carry.
This frontend doesn't call it — `Sidebar.vue`/
`projects.js#groupSessionsByDirectory` derives the group label from the
directory's basename instead. If nicer names are wanted later, check `/doc`
for the real shape of that endpoint on your target server, fetch it once,
and use it as a `directory -> name` lookup keyed off the same directory
string sessions already carry.


---
seo:
  description: Experimental HttpApi surface for selected instance routes.
sidebar:
  label: Overview
title: opencode HttpApi
---
Experimental HttpApi surface for selected instance routes.

<ApiOverview source="api" />

## health

<ApiTagOperations source="api" tag="health" />

## server

<ApiTagOperations source="api" tag="server" />

## location

<ApiTagOperations source="api" tag="location" />

## agent

<ApiTagOperations source="api" tag="agent" />

## plugin

Experimental plugin routes.

<ApiTagOperations source="api" tag="plugin" />

## session

Experimental message routes.

<ApiTagOperations source="api" tag="session" />

## model

Experimental model routes.

<ApiTagOperations source="api" tag="model" />

## generate

Experimental one-shot generation routes.

<ApiTagOperations source="api" tag="generate" />

## provider

Experimental provider routes.

<ApiTagOperations source="api" tag="provider" />

## integration

Integration discovery and authentication routes.

<ApiTagOperations source="api" tag="integration" />

## mcp

MCP server and resource routes.

<ApiTagOperations source="api" tag="mcp" />

## credential

<ApiTagOperations source="api" tag="credential" />

## project

Location-scoped project routes.

<ApiTagOperations source="api" tag="project" />

## form

Session form routes.

<ApiTagOperations source="api" tag="form" />

## permission

Experimental permission routes.

<ApiTagOperations source="api" tag="permission" />

## filesystem

Experimental location-scoped filesystem routes.

<ApiTagOperations source="api" tag="filesystem" />

## command

Experimental command routes.

<ApiTagOperations source="api" tag="command" />

## skill

Experimental skill routes.

<ApiTagOperations source="api" tag="skill" />

## event

Experimental event stream routes.

<ApiTagOperations source="api" tag="event" />

## pty

Experimental location-scoped PTY routes.

<ApiTagOperations source="api" tag="pty" />

## shell

Experimental location-scoped shell command routes.

<ApiTagOperations source="api" tag="shell" />

## question

Experimental session question routes.

<ApiTagOperations source="api" tag="question" />

## reference

Location-scoped project references.

<ApiTagOperations source="api" tag="reference" />

## projectCopy

Project copy management routes.

<ApiTagOperations source="api" tag="projectcopy" />

## vcs

Location-scoped version control routes.

<ApiTagOperations source="api" tag="vcs" />

## debug

<ApiTagOperations source="api" tag="debug" />
