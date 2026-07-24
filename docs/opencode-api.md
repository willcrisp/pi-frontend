# OpenCode V2 HTTP API reference (for this frontend)

This frontend (`web/src/stores/opencode.js`, `projects.js`, `ssh.js`) talks
directly to an OpenCode V2 server's HTTP/SSE API — there is no server-side
component in this repo translating or documenting the protocol, so getting
field names wrong here is a silent runtime bug, not a compile error. This
doc exists because the hosted docs site 403s from this environment and the
API has more than one "Session" shape depending on which HttpApi surface you
hit — both bit us once already (see "Gotcha" below).

## Where to get the authoritative schema

`https://v2.opencode.ai/docs/api/` and `https://v2.opencode.ai/api-reference/*`
return **HTTP 403** through this environment's fetch tooling (WebFetch, and
the same for the DeepWiki mirror) — looks like a Cloudflare block on the
agent proxy, not a real access issue. Don't waste time retrying those URLs.

Instead, pull the type definitions straight from the published SDK package.
It's generated directly from the server's OpenAPI schema, so it's exact —
more reliable than prose docs, and works entirely offline:

```sh
cd /tmp && npm pack @opencode-ai/sdk && tar xzf opencode-ai-sdk-*.tgz
# All request/response shapes:
less package/dist/v2/gen/types.gen.d.ts
# Every endpoint (grouped by resource class), with literal URL templates:
less package/dist/v2/gen/sdk.gen.d.ts   # types only, no URLs
less package/dist/v2/gen/sdk.gen.js     # same classes, but with the literal
                                         # `url: "..."` for every method — grep
                                         # this one when you need the actual path
```

`npm view @opencode-ai/sdk` shows the current published version. It isn't
guaranteed to be byte-identical to whatever server you're pointed at, but in
practice it's the closest thing to ground truth available here. If you have
a live server, `GET /doc` (or whatever OpenAPI path it serves) beats even
this — check first if one's reachable.

## Which class actually matches what this frontend calls

The SDK bundles **several different "Session" classes** mapped to different
route prefixes (`Session`, `Session2`, `Session3` in the `.d.ts`, one of them
reached only via a `V2` wrapper class). They are not interchangeable — two of
them even generate the literal same-looking `/session` URL fragment while
belonging to entirely different mounted API surfaces, so grep hits without
checking the class context will fool you.

This frontend's `apiBase()` (`web/src/stores/ssh.js`) resolves to
`/api/<port>/api` — after the Vite dev proxy strips the `/api/<port>` prefix,
requests land on the real server at `/api/...`. That `/api`-prefixed surface
is the **`V2` class** in the SDK (`sdk.gen.js`'s `class V2`, whose `.session`
getter returns what the `.d.ts` labels `Session3`) — confirm by grepping
`sdk.gen.js` for `url: "/api/session"` etc. Do not read field shapes off the
plain `Session` type or the `Session2` class — those belong to a different,
non-`/api`-prefixed surface this frontend never calls.

### Gotcha: two different session shapes, only one is real here

- `Session` (used by the non-`/api` `Session2.list`) has a **flat**
  `directory: string` field.
- `SessionV2Info` (used by the real `/api/session` — `V2` → `Session3.list`,
  response type `SessionsResponse.data: Array<SessionV2Info>`) has **no**
  top-level `directory`. The project root instead lives at
  `session.location.directory` (`location: LocationRef`, where
  `LocationRef = { directory: string; workspaceID?: string }`).

`projects.js#fetchSessions` reads `s.location.directory` — if you see a PR
or find code reading `s.directory` directly off a `/session` (i.e.
`${apiBase()}/session`) response, it's the flat-`Session` shape got confused
with `SessionV2Info` and will silently produce an empty string for every
session (which collapses the sidebar's per-project grouping into a single
"(unknown project)" bucket instead of erroring).

## Types this frontend actually consumes

### `SessionV2Info` (`GET /session` via `apiBase()`, response: `{ data: SessionV2Info[], cursor }`)

```ts
type SessionV2Info = {
  id: string;
  parentID?: string;
  projectID: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string }; // ModelRef
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  time: { created: number; updated: number; archived?: number };
  title: string;
  location: { directory: string; workspaceID?: string };        // LocationRef — project root lives here
  subpath?: string;
  revert?: RevertState;
};
```

`projects.js` maps this to `{ id, title, updatedAt, directory }`, sorted
most-recently-updated first, then `groupSessionsByDirectory()` groups by
`directory` for the sidebar (`Sidebar.vue`) — one collapsible section per
project root, most recently active first.

List query params (`Session3.list` / literal `GET /api/session`):
`directory`, `workspace`, `scope: "project"`, `path`, `roots`, `start`,
`search`, `limit`. None of these are used yet — the frontend fetches the
full flat list and groups client-side. If the session count grows large
enough that this matters, `directory`/`scope` could push the grouping to the
server instead.

### `ModelV2Info` (`GET /model`, i.e. `${apiBase()}/model`, response: `{ location, data: ModelV2Info[] }`)

Relevant fields: `id`, `providerID`, `name`, `limit: { context, input?, output }`.
`opencode.js#loadModels` maps this to
`{ providerID, modelID: id, label: name || providerID/id, contextLimit: limit.context }`.
`Composer.vue`'s `modelsByProvider` groups the model `<select>`'s options by
`providerID` into `<optgroup>`s.

### Agent (`GET /agent`), Command (`GET /command`)

Consumed as-is by `opencode.js#loadAgents`/`loadCommands` — see the inline
comments there; no gotchas found for these two.

## Endpoint index (the `/api`-prefixed `V2`/`Session3` surface only)

Pulled from `sdk.gen.js`'s `V2` class (grep `url: "/api/` there for the
literal templates + every other resource, e.g. `/api/provider`,
`/api/integration`, `/api/pty`, `/api/fs/*`, `/api/permission/*`). The ones
this frontend currently calls:

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
| GET | `/api/health` (well, `/health`, see `initOpenCode`) | `opencode.js#initOpenCode` |

Not yet used by this frontend but visible in the same `V2` class if a future
feature needs them: session `fork`/`revert`/`compact`/`share`/`wait`/
`context`/`history`, provider listing/auth, PTY (remote shell), permission
requests, `fs/read`/`fs/list`/`fs/find`. Grep `sdk.gen.js`'s `V2` class body
for the full, current list rather than trusting this doc to stay exhaustive.

## Project grouping: no separate `/project` fetch (yet)

There's also a `Project` type (`id`, `worktree`, `name?`, `icon?`, ...) behind
a `GET /project`-style listing, which would let the sidebar show a
user-set `name` instead of the directory basename. This frontend doesn't
call it — `Sidebar.vue`/`projects.js#groupSessionsByDirectory` derives the
group label from `directory`'s basename instead. If nicer names are wanted
later, fetch that list once and use it as a `worktree -> name` lookup keyed
off the same directory string sessions already carry.
