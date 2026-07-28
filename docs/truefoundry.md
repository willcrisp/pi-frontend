# TrueFoundry integration — research & plan

Goal: native TrueFoundry support in radius — pick from every model the gateway
exposes, and see real usage/spend.

⚠️ **Status: desk research.** The session this was written in had no network
route to `truefoundry.com` and no live OpenCode server, so nothing below is
`[observed]` — it is all `[spec]`, assembled from TrueFoundry's public docs via
search. Phase 0 exists precisely to turn the load-bearing claims into
`[observed]` before any code is written. Treat the endpoint shapes the same way
`docs/opencode-api.md` tells you to treat an SDK: as a starting hypothesis to
verify against the tenant in front of you.

## 1. The shape of the problem

The thing worth getting straight first: **radius never calls a model.** OpenCode
does. radius is a client of `opencode2`, and every token that gets spent is spent
by a provider configured inside that server process. So "native TrueFoundry
integration" is not one feature, it is three that live at different layers:

| Want | Lives where | Mechanism |
|---|---|---|
| Inference through the gateway | opencode2 server | a provider block in `opencode.json` on the server host |
| Pick from all gateway models | radius UI + opencode config | fetch the gateway catalog, write the chosen subset into that provider block |
| Usage tracking | radius UI | TrueFoundry's metrics API (plus the per-session numbers we already have) |

The second one is the interesting bit, and it is why this can't be a pure
frontend feature: the composer's model picker is fed by `GET /api/model`, which
is derived from opencode's own provider table. A model that isn't in opencode's
config cannot be selected, no matter what the frontend knows about it. So the
frontend's job is to *discover* models at TrueFoundry and *write them into
opencode's config* — the same shape as `subagents.js`, which discovered it
couldn't create agents over HTTP and settled on writing markdown files through
the PTY.

That precedent matters, and it carries its worst property with it: **opencode
reads config once at startup and does not hot-reload.** Any model we add to the
config is not selectable until the server restarts. The sub-agents dialog already
solved the UX for this ("restart to apply"); we reuse it verbatim.

## 2. TrueFoundry surface (all `[spec]`)

### Auth

A single bearer token, either a **Personal Access Token** (dev, what you have)
or a **Virtual Account Token** (production, survives the user leaving). Same
header for the gateway and the control plane:

```
Authorization: Bearer <token>
```

PATs don't expire by default, though an expiry can be set and org admins can cap
the maximum validity.

### Two different base URLs

This tripped up the research and will trip up the implementation, so keep them
separate in the store:

- **Gateway (inference + model discovery)** —
  `https://<tenant>.truefoundry.cloud/api/llm/api/inference/openai`
  OpenAI-compatible: `/chat/completions`, `/models`. There is also an
  Anthropic-compatible `/v1/messages` surface (TrueFoundry documents it as a
  Claude Code proxy target via `ANTHROPIC_BASE_URL`).
- **Control plane (metrics, admin)** — `https://<tenant>.truefoundry.cloud`,
  with metrics under `/api/svc/v1/llm-gateway/metrics/query`.

The exact path segments are the single most important thing for Phase 0 to
confirm; docs and blog posts disagree on `/api/llm/...` vs `/api/inference/...`
vs the versioned `/v1` suffix, and the tenant is authoritative.

### Model discovery

`GET <gateway>/models` returns an OpenAI-shaped list — `{object: "list", data:
[{id, object, owned_by}]}` — scoped to what the token is allowed to see.

Model IDs are namespaced `provider_account/model_name`: `openai-main/gpt-4o-mini`,
`anthropic-main/claude-4-sonnet`. The account prefix is a gateway-side concept
(an org can have `openai-main` and `openai-dev` pointing at different keys), not
part of the upstream model name.

Two consequences worth calling out now:

1. **The IDs contain a slash.** opencode's string form for a model is
   `providerID/modelID`, so `truefoundry/openai-main/gpt-4o` has two slashes.
   The HTTP paths radius uses are safe — `Model.Ref` is the structured
   `{id, providerID, variant?}` object, and `opencode.js#selectModel` already
   sends that. But sub-agent frontmatter (`subagents.js`) writes the *string*
   form, and `.opencode/agent/*.md` files are parsed by the server. Whether
   opencode splits on the first slash or the last decides whether sub-agents can
   use gateway models at all. **Phase 0 must test this**; it is the most likely
   place the integration quietly half-works.
2. **The response carries no capability metadata** — no context window, no
   pricing, no tool-support flag. radius uses `limit.context` for the context-%
   bar in `ChatHeader.vue` / `UsagePopover.vue`, and opencode uses its pricing
   table to compute `cost` per message. Both go blank for a custom provider
   unless we supply the numbers. See §5.

### Request tagging

`X-TFY-METADATA` takes a JSON object of string→string (values ≤128 chars) and
every key becomes a queryable filter/grouping in analytics:

```
X-TFY-METADATA: {"application":"radius","environment":"uat"}
```

### Metrics

`POST https://<tenant>.truefoundry.cloud/api/svc/v1/llm-gateway/metrics/query`,
bearer-authed, JSON body along the lines of:

```json
{
  "startTs": 1750000000,
  "endTs":   1750086400,
  "datasource": "...",
  "type": "distribution",
  "aggregations": [{ "type": "sum", "column": "..." }],
  "groupBy": ["model_name"]
}
```

`type` is `"distribution"` (aggregated) or `"timeseries"`, with filters and
`groupBy` over fields including `username`, `model_name`, `teams`, and any key
you passed in `X-TFY-METADATA`. The published example is for *agent* metrics
(p50/p99 latency grouped by `agentName`); the LLM-token/cost datasource is
documented as existing but its column names were not pinned down. Phase 0 pins
them.

## 3. Wiring inference: the provider block

opencode supports custom OpenAI-compatible providers in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "truefoundry": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TrueFoundry",
      "options": {
        "baseURL": "https://<tenant>.truefoundry.cloud/api/llm/api/inference/openai",
        "headers": { "X-TFY-METADATA": "{\"application\":\"radius\"}" }
      },
      "models": {
        "openai-main/gpt-4o": { "name": "GPT-4o (openai-main)" },
        "anthropic-main/claude-4-sonnet": { "name": "Claude 4 Sonnet (anthropic-main)" }
      }
    }
  }
}
```

Global scope is `~/.config/opencode/opencode.json`, next to the
`~/.config/opencode/agent/` directory `subagents.js` already writes to. The token
goes in `options.apiKey` or opencode's separate credential store
(`~/.local/share/opencode/auth.json`, `{providerID, type: "api", key}`) —
Phase 0 decides which the V2 build honours.

Whether `opencode2` still reads on-disk `provider` blocks is **the** open
question. V2 dropped `/api/config` from the HTTP surface, but the on-disk loader
demonstrably still runs (that is how sub-agents work at all), so the odds are
good — but this is a load-bearing assumption and it gets tested first, before
any UI is built.

**A second provider entry for Claude models is worth considering.** Routing
Anthropic models through `@ai-sdk/openai-compatible` costs you the Anthropic-
native features (cache control, extended thinking) that opencode's own anthropic
provider knows how to drive — and given the cache-read/cache-write numbers
`UsagePopover.vue` displays, prompt caching is not something to give up quietly.
A `truefoundry-anthropic` provider pinned at the gateway's `/v1/messages` surface
would keep them. Defer to Phase 4; get one provider working first.

## 4. Wiring the frontend

### Reaching TrueFoundry from the browser

The dev proxy in `web/vite.config.js` only forwards `/api/<port>/*` to
`127.0.0.1:<port>` — it cannot reach an external host, and a production `dist/`
build has no proxy at all. A direct `fetch()` to `<tenant>.truefoundry.cloud`
depends on CORS headers we have no reason to assume.

Use the PTY. `pty.js#runScript` runs a shell on the OpenCode host; a
`curl -s -H "Authorization: Bearer …" <gateway>/models` there has no CORS
problem, works identically in dev and in a built bundle, and is exactly how
`git.js`, `filesearch.js` and `remotefs.js` already reach server-side
capabilities the HTTP API doesn't offer. Model-catalog sync and a metrics
refresh are both occasional, user-initiated operations — the PTY round-trip cost
doesn't matter.

Two things to respect: `runScript`'s ~1000-char-per-line limit (base64 a long
metrics body across lines the way `remotefs.js#writeTextFile` does), and the
fact that a token on a shell command line is visible in the host's process list
for the life of the call. Prefer feeding it via a heredoc into curl's
`--config -` over putting it in `argv`.

### New store: `stores/truefoundry.js`

Plain `reactive()` singleton like everything in `stores/`. Holds:

- `controlPlaneUrl`, `gatewayUrl` (derived, overridable), `token` — persisted to
  localStorage under `opencode-web:tfy*`, matching `ssh.js`'s convention. Note
  the posture: the PAT sits in localStorage exactly like the existing basic-auth
  password does. Consistent with what's there, and worth saying out loud rather
  than discovering later.
- `catalog[]` — models from the gateway, `{id, account, model, owned_by}`.
- `selected` — the Set of gateway IDs the user wants in opencode's config.
- `usage` — the last metrics query result.
- `status` / `error` / `notice` — including the sticky "restart to apply" notice,
  copied from `subagentsStore`.

Functions: `testConnection()`, `loadCatalog()`, `writeProviderConfig()`,
`loadUsage(range)`.

### New dialog: `TrueFoundryDialog.vue`

Mounted from `Sidebar.vue` alongside `ProvidersDialog` and `SubagentsDialog`.
Three tabs, matching the three layers in §1:

1. **Connection** — tenant URL, PAT, Test. Same layout language as
   `ConnectDialog.vue`.
2. **Models** — the fetched catalog, searchable, grouped by provider account,
   with checkboxes. Save writes the provider block and raises the restart
   notice.
3. **Usage** — see §6.

**The model list needs an allowlist, not a blocklist.** The gateway can expose
250–1000+ models. `modelfilter.js` today is opt-out — it hides models you tick —
which is the right default for a handful of connected providers and completely
wrong for a thousand. Selecting into `provider.truefoundry.models` *is* the
allowlist, and it has the pleasant side effect that only chosen models ever reach
`GET /api/model`, so the composer picker and `ModelFilterPopover` need no changes
at all. That's the main argument for doing selection at config-write time rather
than filtering in the picker.

## 5. Fixing what a custom provider breaks

Since `@ai-sdk/openai-compatible` models carry no metadata, two existing features
degrade silently. Both are fixable in the same place — the per-model entry in the
config we're already writing:

```json
"openai-main/gpt-4o": {
  "name": "GPT-4o (openai-main)",
  "limit": { "context": 128000, "output": 16384 },
  "cost":  { "input": 2.5, "output": 10 }
}
```

- **Context bar** (`sessionStats.contextUsage`) needs `limit.context`, or it
  falls back to the local estimate and eventually shows nothing.
- **Cost** (`sessionStats.cost`, `UsagePopover`) is computed by opencode from
  its pricing table; with no table entry it reads 0.

Where do the numbers come from? Best case, the tenant's control plane exposes
richer per-model metadata than the OpenAI-shaped `/models` response does — worth
ten minutes in Phase 0, because it makes this automatic. Failing that, match on
the model-name half of the ID against opencode's own catalog for models it
already knows (`gpt-4o` is `gpt-4o` whichever account fronts it) and leave the
rest blank. Do **not** hand-maintain a pricing table in this repo; it will rot.

Note the honest fallback if cost stays blank: per-session cost is dead, but §6's
gateway-side numbers are unaffected — and they're the authoritative ones anyway.

## 6. Usage tracking

Two sources, and they answer different questions:

**Per-session, already working.** `sessionStats.tokens` / `.cost` from message
metadata, rendered by `UsagePopover.vue` with a sub-agent breakdown. Live, exact
per-session, and the only view that knows what a *session* is. Cost depends on §5.

**Gateway-side, new.** The metrics API gives spend/tokens/latency across
everything the token can see, grouped by model, user, team, or metadata key.
Authoritative on money, aggregate in nature, and the reason to do this at all.

A "Usage" tab in the dialog: a range selector (24h / 7d / 30d), total spend and
tokens, a by-model breakdown, and a request-count timeseries. Any chart should
stay hand-rolled inline SVG — this repo hand-rolls markdown and diffing rather
than take dependencies, and a sparkline is well inside that budget.

**The attribution limit, stated up front.** Per-*session* attribution at the
gateway is not achievable. `X-TFY-METADATA` would carry it, but the header is
static in the provider config, read once at server start; opencode gives us no
per-request header hook. So we can tag traffic as coming from radius
(`{"application":"radius"}`), and the gateway can already group by model and by
user — but "what did session ses_abc cost" is answerable only from the local
numbers, and correlating the two by timestamp would be guesswork. Don't build
that. If it matters later, the ask is upstream: per-request metadata in
opencode's provider options.

## 7. Phases

**Phase 0 — verify (no code).** Run against the real tenant and the ALF-UAT
server. Nothing after this is safe to build without it:

```sh
# 1. Gateway base URL + catalog shape
curl -s -H "Authorization: Bearer $TFY_TOKEN" \
  https://<tenant>.truefoundry.cloud/api/llm/api/inference/openai/models | jq .

# 2. Does an inference call work, and what does usage look like coming back?
curl -s -H "Authorization: Bearer $TFY_TOKEN" -H 'Content-Type: application/json' \
  -H 'X-TFY-METADATA: {"application":"radius"}' \
  -d '{"model":"openai-main/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
  https://<tenant>.truefoundry.cloud/api/llm/api/inference/openai/chat/completions | jq .

# 3. Metrics: datasource names and column names for tokens/cost
curl -s -X POST -H "Authorization: Bearer $TFY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"startTs":...,"endTs":...,"type":"distribution","aggregations":[...],"groupBy":["model_name"]}' \
  https://<tenant>.truefoundry.cloud/api/svc/v1/llm-gateway/metrics/query | jq .

# 4. Is there per-model metadata (context, pricing) anywhere on the control plane?
#    Check the tenant's own OpenAPI rather than the docs site.
```

And on the opencode host:

```sh
# 5. THE load-bearing one: does opencode2 read a provider block from config?
#    Write the block, restart, then:
curl -s -u opencode:$PW http://127.0.0.1:4096/api/model | jq '.data[].providerID' | sort -u

# 6. The slash question — does a two-slash model string resolve in agent frontmatter?
#    Write a .opencode/agent/tfy-test.md with
#    model: truefoundry/openai-main/gpt-4o-mini, restart, dispatch it.
```

Record the answers in this file, flipping each claim from `[spec]` to
`[observed]`, the way `docs/subagents-alfuat.md` does.

**Phase 1 — connection + catalog (read-only).** `stores/truefoundry.js` with
settings, `testConnection()`, and `loadCatalog()` over the PTY.
`TrueFoundryDialog.vue` with the Connection and Models tabs, list rendering only.
Nothing is written to the server; this phase is safe to ship half-finished.

**Phase 2 — config write.** Model selection → `writeProviderConfig()` merging
`provider.truefoundry` into `~/.config/opencode/opencode.json` via
`remotefs.js`. Merge, never overwrite — that file may hold unrelated user config,
so read it, patch the one key, write it back, and refuse to write if it doesn't
parse. Restart notice reused from `subagentsStore`. After a restart the models
appear in the existing picker with no picker changes. **This is the milestone
that delivers "pick from all the models."**

**Phase 3 — usage.** `loadUsage()` against the metrics API, Usage tab, hand-rolled
SVG. Cross-link from `UsagePopover.vue` ("session totals — see TrueFoundry for
account-wide spend").

**Phase 4 — fidelity.** Context limits and pricing into the per-model entries
(§5). Optional `truefoundry-anthropic` provider on the `/v1/messages` surface for
Claude models with caching intact (§3). Revisit `modelfilter.js` if the picker
still feels crowded.

## 8. Open questions

1. Does `opencode2` honour on-disk `provider` blocks? *(Phase 0 #5 — blocks
   everything.)*
2. Where does the token go: `options.apiKey`, `options.headers`, or
   `auth.json`?
3. Does a two-slash `providerID/account/model` string parse in agent
   frontmatter? *(Phase 0 #6 — decides whether sub-agents can use gateway
   models.)*
4. Exact gateway path segments for this tenant.
5. Metrics datasource/column names for tokens and cost.
6. Is per-model metadata (context window, pricing) available anywhere on the
   control plane, or is §5 a manual job?
7. Does `GET /api/integration` already list something TrueFoundry-shaped or a
   generic OpenAI-compatible entry? If so, `connectKey` might do part of this
   with no config writing at all — cheap to check, and it would simplify
   Phase 2 substantially.
