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
  `providerID`, `name`, `limit.context`. Mapped to `{ providerID, modelID:
  id, label: name || providerID/id, contextLimit: limit.context }`.
  `Composer.vue`'s `modelsByProvider` groups the model `<select>`'s options
  by `providerID` into `<optgroup>`s.
- **`GET /api/agent`**, **`GET /api/command`** — consumed close to as-is;
  see the inline comments in `opencode.js#loadAgents`/`loadCommands`.

## Endpoints this frontend calls

| Method | Path | Used by |
|---|---|---|
| GET | `/api/session` | `projects.js#fetchSessions` |
| POST | `/api/session` | `projects.js#startNewChat` |
| DELETE | `/api/session/{sessionID}` | `projects.js#removeSession` |
| GET | `/api/session/{sessionID}/message` | `opencode.js#refreshActiveMessages` |
| POST | `/api/session/{sessionID}/prompt` | `opencode.js#sendPrompt` |
| POST | `/api/session/{sessionID}/interrupt` | `opencode.js#abortSession` |
| POST | `/api/session/{sessionID}/model` | `opencode.js#setModel` |
| POST | `/api/session/{sessionID}/agent` | `opencode.js#setAgent` |
| GET | `/api/model` | `opencode.js#loadModels` |
| GET | `/api/agent` | `opencode.js#loadAgents` |
| GET | `/api/command` | `opencode.js#loadCommands` |
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
