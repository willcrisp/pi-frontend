# TrueFoundry integration reference (for this frontend)

TrueFoundry is an AI gateway that fronts many upstream providers behind one
OpenAI-compatible endpoint. This frontend discovers the models a PAT can reach,
lets the user import a chosen subset, and writes them into OpenCode's config as
a custom provider.

Getting a field name or a config key wrong here is a **silent** failure, not a
compile error — and in one specific case (see "The config shape" below) a wrong
key produces valid JSON that OpenCode reads and ignores.

Claims below are marked **[verified]** (probed against a live system or read
from a published schema) or **[unverified]** (believed correct, never exercised
end-to-end). Nothing in this integration has been run against a live gateway
*from this codebase* — the verified gateway facts come from a prior session's
`curl` probes, recorded in the handover PDF that seeded this work.

## Two hosts, two jobs

| | Purpose | Auth |
|---|---|---|
| **The gateway** (`https://gateway.ai.fortescue.com`) | Model discovery, inference | `Authorization: Bearer <PAT>` |
| **The tenant/control-plane API** (same host, `/api/svc/v1/...`) | Enabled-model inventory, usage metrics | Same PAT |

On Fortescue both live on one host. TrueFoundry's own docs describe the metrics
API under `{control_plane_url}`, so a deployment that splits them is possible —
check before assuming. **[unverified]**

## Endpoint inventory

### `GET /models` — standard OpenAI-compatible discovery

The documented discovery route. Returns:

```json
{ "object": "list", "data": [{ "id": "provider-account/model-id", "object": "model", "owned_by": "provider-account" }] }
```

⚠️ **On Fortescue this returns the tenant's SPA, not JSON** — HTTP 200 with
`Content-Type: text/html; charset=utf-8`. **[verified]**

**Never infer authentication success from a 200 here.** A frontend route
answering 200 says nothing about whether the PAT is valid. `discoverTrueFoundry`
treats a non-JSON body as a failure and falls through.

### `GET /api/svc/v1/llm-gateway/model/enabled` — the tenant's real inventory

What actually answers on Fortescue. **[verified]** Keyed *twice* — by broad
provider type, then by configured provider **account**:

```js
{
  "openai":        { "openai": [ /* models */ ] },
  "aws-bedrock":   { "aws-bedrock": [ ... ] },
  "virtual-model": { "general-virtual-models": [ ... ], "vm-ainchor-mcp": [ ... ] }
}
```

The second level is the operationally meaningful one: a tenant can run several
accounts under one provider type (`virtual-model` above has two), and model ids
are scoped by account.

Each model carries: `id`, `model_id`, `model_fqn`, `name`, `provider`,
`provider_account_name`, `types`, `created_by`, `tenant_name`. **[verified]**

It does **not** carry context limits, output limits, pricing, tool support, or
reasoning variants. That absence drives real behaviour — see "Unpriced models"
below.

Group counts observed on Fortescue, before chat filtering: **[verified]**

```
openai/openai 65 · aws-bedrock/aws-bedrock 50 · aws-bedrock-mantle 48
google-vertex 57 · databricks 23 · aws-claude-platform 12
general-virtual-models 4 · aws-sagemaker 3 · azure-foundry/azure-ai-foundry 2
custom-endpoint/oai-sora-platform 1 · virtual-model/vm-ainchor-mcp 1
```

Roughly 270 entries. Any UI here has to assume hundreds of models, not dozens.

### `POST /api/svc/v1/llm-gateway/metrics/query` — usage metrics

```json
{ "startTs": 0, "endTs": 0, "datasource": "modelMetrics",
  "type": "distribution", "interval": "1 day",
  "aggregations": [{ "type": "sum", "column": "cost" }], "groupBy": ["modelName"] }
```

`type` is `"distribution"` (aggregate) or `"timeseries"` (needs `interval`).
`datasource` selects the metric family — `agentMetrics` is the documented
example, with Model, MCP, Guardrail, Cache and Routing families alongside.
`groupBy` accepts model, user, team and custom metadata dimensions.

⚠️ **[unverified], and shakier than the rest.** TrueFoundry's docs domain is
403-blocked from this environment's proxy, so this comes from search-result
summaries, not a page anyone read. The exact `datasource` name for model usage
and the response's column names are guesses consistent with the documented
example. `stores/usage.js` therefore reads results tolerantly (`pick()` tries
several column spellings) rather than assuming — a wrong guess should yield
nothing, not a confident wrong number.

### `POST /api/svc/v1/spans/query` — per-request logs

Needs a `tracing_project_fqn`, obtainable from the Request Logs page's "Fetch
via API" button. Not used by this frontend. **[unverified]**

### Inference

`POST {gateway}/api/inference/openai/chat/completions`, OpenAI-shaped. Used only
by the connection test. **[unverified]** — worth confirming the path against
your tenant, since the SPA interception on `/models` proves this gateway does
route some paths to a frontend.

## The config shape

**This is the trap that matters most.** OpenCode's published `opencode.json`
schema uses **`provider`** (singular), **`npm`**, and **`options`**:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "truefoundry": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TrueFoundry",
      "options": { "baseURL": "https://gateway.ai.fortescue.com" },
      "models": { "openai/gpt-5-mini": { "name": "gpt-5-mini" } }
    }
  }
}
```

**[verified]** against the published schema.

An earlier design of this feature used `providers` / `package` / `settings`.
All three are wrong. That block is still valid JSON, so nothing errors — the
file writes, the UI reports success, and OpenCode ignores the provider entirely.
If models never appear after a restart, check these three keys first.

### Where it's written

`~/.config/opencode/opencode.json` — the **global** config, so imported models
are available in every project. Same directory `subagents.js` writes global
agent definitions to.

OpenCode's precedence, lowest first:

```
~/.config/opencode/opencode.json(c)      ← we write here
<project>/opencode.json(c)
<project>/.opencode/opencode.json(c)
```

A project declaring its own `provider.truefoundry` therefore overrides the
global block locally. That's the correct direction, but it means a repo with a
committed `.opencode/opencode.json` can quietly shadow your global setup.

### JSONC is refused, not rewritten

If `~/.config/opencode/opencode.jsonc` exists, the save stops with an actionable
error. `JSON.parse` can't read JSONC, and stripping comments with a regex
corrupts strings that merely look like comments. Destroying a config to save one
manual edit is not a trade worth making.

### The whole provider block is replaced

Not deep-merged. A merge can't express a *removal*, so deselecting a model could
never drop it. The cost: hand-added headers or limits on this one provider are
overwritten. Everything outside `provider.truefoundry` is preserved.

## Credentials

Three rules, in order of importance:

1. **The PAT is never written to any config file.** The generated block carries
   no credential.
2. **The PAT is never persisted by the frontend** — not `localStorage`, not
   `sessionStorage`, not the discovery cache.
3. **The PAT never goes in argv.** `curl` reads a config from **stdin**, so the
   token doesn't appear in the host's process list. The PTY title is fixed text.

The PAT is validated against `/^[A-Za-z0-9._~-]+$/` before it enters that config
— a newline or quote would otherwise let a caller inject curl directives. Real
TrueFoundry PATs are JWT-like and fit comfortably.

### Read-through from `.env`

To avoid re-typing after every restart, a PAT is read from the host's `.env`:

- Keys, in order: `TRUEFOUNDRY_API_KEY`, `TRUEFOUNDRY_PAT`, `TFY_API_KEY`
- Files, in order: the open project's `.env`, then `~/.config/opencode/.env`
- A typed token always wins over the file.

The value is held in **module scope in `providers.js`, not in `providersStore`**
— everything in that store is reachable from any importing component and from
Vue devtools. The store carries only `{key, path}`. It is likewise never loaded
into the password input, whose value can be revealed by flipping the input's
`type`.

### ⚠️ Why the config doesn't use `{env:...}`

OpenCode supports `{env:VAR}` substitution in config values, and putting
`"apiKey": "{env:TRUEFOUNDRY_API_KEY}"` in `options` looks like the obvious
answer. **It is a known OpenCode bug that this specific case fails** — `{env:}`
substitution does not work for `apiKey` inside a custom provider's `options`
under `@ai-sdk/openai-compatible`, substituting an empty string and failing at
the gateway with an error that points nowhere near the cause.
([anomalyco/opencode#19946](https://github.com/anomalyco/opencode/issues/19946);
`{file:...}` reportedly works where `{env:}` doesn't.)

So inference authenticates through OpenCode's credential store:
`POST /api/integration/truefoundry/connect/key {key, label}` — which only exists
*after* the server has loaded the provider.

## The setup flow, and why it needs a restart

1. Discover → select → **Add N selected models**. Writes the global config.
2. **Restart OpenCode.** Config is read at startup and is not hot-reloaded (the
   same reason `subagents.js` marks new definitions "restart to apply").
   **[unverified]** for providers specifically — check `/openapi.json` for a
   config or reload route on your build before assuming.
3. **Reload the browser page.** `loadModels()` runs only in `initOpenCode()`
   (`stores/opencode/stream.js`); the SSE reconnect handler deliberately
   re-runs only pending questions and run-state reconciliation. So after an
   OpenCode restart the stream reconnects, everything *looks* healthy, and the
   model catalog is silently stale. **[verified]** — a known papercut, not yet
   fixed.
4. Re-enter the PAT and save. Now the integration exists, so it reaches the
   credential store.

Steps 1–3 repeat on **every** change to the model selection, because the model
map lives in the config file. Only the PAT is live-updatable.

## Model normalization

`lib/truefoundry.js` is pure and handles both payload shapes.

| Field | Precedence |
|---|---|
| `id` | `model_fqn \|\| model_id \|\| id` |
| `name` | `name \|\| model_fqn \|\| model_id \|\| id` |
| `account` | `provider_account_name \|\| <2nd-level key> \|\| owned_by \|\| "Other"` |
| `provider` | `provider \|\| <1st-level key> \|\| owned_by \|\| ""` |

**The id sent to the gateway must be `model_fqn`**, not the bare `name`.

Only `chat`/`responses` types are kept — the enabled endpoint also lists
embeddings, image models and Sora, which would become picker entries that break
on first prompt. A model with no `types` at all is kept, since the standard
`/models` shape carries none.

### Custom provider ids contain slashes

A normalized id is `openai/gpt-5-mini`, so the full OpenCode reference is
`truefoundry/openai/gpt-5-mini`. **This is safe here** and needs no special
handling: the app carries `{providerID, modelID}` as separate fields throughout
(`catalog.js` builds them from separate API fields, `useModelPicker.js` keys its
select on `:` not `/`, `SubagentsDialog.vue` splits on the *first* slash).
**[verified]** by reading the code. Don't "fix" the parser speculatively.

## Unpriced models: what breaks, and why usage tracking exists

The discovery endpoints supply no pricing and no context limits, and
`buildProviderConfig` refuses to invent them — a fabricated context limit would
put a wrong number in front of the user via the context bar.

Consequences, both **[verified]** by reading the code:

- `sessionStats.cost` sums a per-message `cost` the server computes from pricing
  it doesn't have → **`$0.00` for every TrueFoundry model**.
- `context.js` looks up `contextLimit` from the catalog, finds none →
  `setDerivedContextPercent` yields `percent: 0` → **the context bar flatlines**.

So migrating to TrueFoundry silently breaks the existing usage display. That is
why `stores/usage.js` exists: local totals from the session list, and gateway
metrics as the authoritative cost when the local figure is 0.

## In the composer picker

- **Label** is the short `name` (`gpt-5-mini`), not the fully-qualified id.
- **Grouping** is by `providerID`, so *everything* lands under one `truefoundry`
  header. The provider-account structure used at import time does not carry
  through. Two accounts serving the same model name produce two identical
  labels.
- **The dot colour is meaningless for these models.** `MODEL_RANK` in
  `useModelPicker.js` is `["sol", "terra", "luna"]`, matched as a substring of
  the label. No TrueFoundry model matches, so all rank equally, keep server
  order, and `rampColor` assigns the low→max ramp *by list position*. It looks
  like a capability ranking and isn't.

## File map

| File | Owns |
|---|---|
| `src/lib/truefoundry.js` | Pure: normalization, grouping, config generation and merge |
| `src/lib/dotenv.js` | Pure: minimal `.env` parsing for the PAT read-through |
| `src/stores/providers.js` | Discovery, connection test, config write, `.env` read-through, cache |
| `src/stores/usage.js` | Local session aggregation + gateway metrics |
| `src/components/dialogs/ProvidersDialog.vue` | The TrueFoundry card |
| `src/components/dialogs/UsageDialog.vue` | Usage history and gateway breakdown |
| `public/truefoundry.svg` | Stand-in mark — **not** the official brand asset |
| `test/providers.spec.js` | Selection UI, seeded via the discovery cache |
| `test/dotenv.spec.js` | `.env` parsing edge cases |
| `test/usage.spec.js` | Usage aggregation and chart |

Discovery results are cached per gateway in `localStorage`
(`opencode-web:truefoundry-cache`), the way `git.js` and `filesearch.js` cache
their own PTY results. Only the model inventory — never the PAT. This is also
the seam the Playwright tests seed, since PTY has no mock.

## Known gotchas, condensed

1. `providers` / `package` / `settings` are the wrong config keys and fail
   silently. It's `provider` / `npm` / `options`.
2. HTTP 200 from `/models` on Fortescue is SPA HTML, not proof of auth.
3. `{env:}` doesn't work for `apiKey` under `@ai-sdk/openai-compatible`.
4. Config changes need an OpenCode restart **and** a browser reload, every time.
5. A project-level config silently overrides the global provider block.
6. Cost reads `$0.00` and context reads 0% for these models by construction.
7. Catalogue visibility ≠ callability — the connection test is the only thing
   that proves a model actually answers.

## Still unverified end-to-end

Nothing in this integration has been exercised against a live gateway or a
running OpenCode from this codebase. Outstanding:

- Discovery against a real tenant through `runScript()` and the PTY WebSocket.
- Writing the global config over PTY from this UI.
- Restarting OpenCode and seeing `truefoundry` in `GET /api/integration`.
- Persisting the PAT via `connect/key`, and seeing models in `GET /api/model`.
- Selecting a slash-containing model in the composer and prompting through it.
- Tool calling through any imported model.
- Every field name in the metrics API.
- Whether each model marked `chat`/`responses` is genuinely OpenAI-compatible.

All of it needs a local machine, a running server, and a **freshly rotated PAT**
— the token pasted into the session that started this work is compromised and
must never be reused.

## References

- [OpenCode config](https://opencode.ai/docs/config/) — schema, `{env:}`/`{file:}` substitution
- [anomalyco/opencode#19946](https://github.com/anomalyco/opencode/issues/19946) — the `{env:}` apiKey bug
- [TrueFoundry: API access to agent metrics](https://www.truefoundry.com/docs/ai-gateway/fetch-agent-metrics)
- [TrueFoundry: API access to logs](https://www.truefoundry.com/docs/ai-gateway/fetch-request-logs)
- [TrueFoundry: view metrics](https://www.truefoundry.com/docs/ai-gateway/analytics)
- `docs/plan-truefoundry-usage.md` — the plan this was built from, and its outcome
