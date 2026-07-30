# Plan: TrueFoundry integration and usage tracking

Status: **implemented**. All phases landed; see "Outcome" at the end for what
was verified and what still needs a live server.

Supersedes the TrueFoundry handover PDF supplied on 2026-07-30, which described
work in a **different worktree** (`/home/coder/pi-frontend`, uncommitted, on
`main`). None of that code exists in this repository — the tree is clean and
`src/` contains no `truefoundry` reference. Treat the PDF as a design record and
a source of verified endpoint facts, not as a description of this codebase.

## Scope decisions

| Decision | Choice |
|---|---|
| Usage scope | Personal only — session/project totals plus own gateway spend. No team/org rollup. |
| Usage UI | Keep `UsagePopover.vue` for at-a-glance stats; add a dedicated dialog for history and breakdowns. |
| JSONC config editing | Out of scope. Refuse with an actionable error, as the PDF proposed. |
| Selections across rediscovery | Preserve by intersecting previous IDs with newly discovered ones. |

## Corrections to the prior handover

Checked against this codebase; three of its open items are already answerable.

**Nested slashes are already safe.** The PDF's remaining-work item 6 asks to
verify that `truefoundry/openai/gpt-5-mini` survives model selection. It does,
and no change is needed: the app never round-trips a `provider/model` string.
`stores/opencode/catalog.js:31` builds `{providerID, modelID}` from separate API
fields, `composables/useModelPicker.js:114` keys its select on `:` rather than
`/`, and `components/dialogs/SubagentsDialog.vue:64` splits on the *first*
slash. Do not change the parser speculatively.

**The config schema is unverified and is the highest risk in the feature.** The
PDF specifies `{"providers": {...}}` with `package` and `settings` keys. The
upstream OpenCode config schema uses `provider` (singular) with `npm` and
`options`. `docs/opencode-api.md` does not cover config-file provider shape at
all. If this is wrong the UI reports success while OpenCode silently ignores the
block, which is the worst available failure mode. Settle it before writing the
config writer.

**Dirty-worktree hazards do not apply.** `.opencode/`, `pi-serena/`, `web/` and
`.vscode/` are not present here.

## The link between the two features

TrueFoundry models carry no pricing, context limits or capability metadata — the
generated config has only `modelID` and `name`. Following that through:
`stores/opencode/context.js:29` looks up `contextLimit` from the catalog, finds
nothing, and `setDerivedContextPercent` yields `percent: 0`; `sessionStats.cost`
sums a per-message `cost` the server computes from pricing it does not have.

**Switching to TrueFoundry models therefore breaks the existing usage display:**
cost reads `$0.00` and the context bar flatlines. The gateway metrics API is the
authoritative fix, which is why these two requests are one piece of work.

## Part A — TrueFoundry integration

### A1. Settle the config schema — **resolved**

The published opencode.json schema uses **`provider`** (singular), **`npm`** for
the adapter, and **`options`** for per-provider settings:

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

The handover's `providers` / `package` / `settings` was wrong on all three keys.
A config written to that spec parses as valid JSON and is silently ignored by
OpenCode — the failure mode this phase existed to prevent. Encoded in
`lib/truefoundry.js#buildProviderConfig`.

### A2. Pure logic in `src/lib/truefoundry.js`

Dependency-free and unit-testable, matching `markdown.js` / `diff.js` /
`fuzzy.js`:

- `normalizeModels(payload)` — both the standard `{data: [...]}` shape and the
  Fortescue provider-keyed shape. ID precedence `model_fqn || model_id || id`;
  account precedence `provider_account_name || discoveryAccount || owned_by`.
  Retain only `chat` / `responses` types. Dedupe by FQN, sort by display name.
- `groupByAccount(models)` — provider account is the primary grouping key.
- `buildProviderConfig({gateway, models})` and `mergeIntoConfig(existing, block)`.

The PDF put all of this inside `providers.js` next to the PTY calls, then listed
"isolate it so it can be tested without a real PTY" as remaining work. Doing it
this way up front costs nothing.

### A3. Store wiring in `src/stores/providers.js`

`trueFoundry: {models, busy, error, notice}` state plus `discoverTrueFoundry`
and `configureTrueFoundry`. Discovery runs over PTY + `curl` (browser CORS is
not dependable across tenants and Radius has no backend), trying `/models`
first and falling back to `/api/svc/v1/llm-gateway/model/enabled` when the
standard route returns the tenant SPA.

Security properties to preserve verbatim from the PDF:

- PAT validated against `/^[A-Za-z0-9._~-]+$/` before it enters a curl config.
- PAT passed via a curl config on **stdin**, never in argv.
- PAT never written to a project file, `localStorage` or `sessionStorage`.
- PTY title is fixed text and carries no secret.
- A 200 with `text/html` is not treated as authentication success.

### A4. UI in `ProvidersDialog.vue` + `public/truefoundry.svg`

Two stages — discover, then select — grouped by provider account, with
indeterminate group checkboxes and nothing selected by default. Styles go in the
dialog's existing `<style scoped>` block, which avoids touching the load-bearing
`@import` order in `src/style.css`.

Beyond the PDF's version, for a catalogue of roughly 270 chat models:

- Fuzzy search over the catalogue using `lib/fuzzy.js`.
- Already-imported state, cross-referenced against `opencodeStore.availableModels`.
- Selections preserved across rediscovery.
- **A real connection test** — one cheap completion through a selected model.
  Catalogue visibility is not callability; this is the PDF's largest untested
  risk and the difference between a card that looks right and one that works.

## Part B — Usage tracking

### Researched API surface

Both endpoints sit on the same `/api/svc/v1/` base as the verified
`model/enabled` route.

| Endpoint | Purpose |
|---|---|
| `POST /api/svc/v1/llm-gateway/metrics/query` | Aggregated tokens, cost, requests, latency |
| `POST /api/svc/v1/spans/query` | Per-request logs; needs `tracing_project_fqn` |

Metrics body: `{startTs, endTs, datasource, type: "distribution" \| "timeseries",
aggregations: [{type, column}], groupBy: [...], interval?}`. `datasource`
selects the metric family (`agentMetrics` documented; Model, MCP, Guardrail,
Cache and Routing alongside). `groupBy` accepts model, user, team and custom
metadata dimensions.

⚠️ These shapes come from search-result summaries. TrueFoundry's docs domain is
blocked by the container proxy (403 on `truefoundry.com` and
`docs.truefoundry.com`), so no doc page was read directly. Verify field names
against the live tenant before building against them.

### Tier 1 — Cross-session usage, no new API

`GET /api/session` returns `cost` and `tokens` on every `SessionV2.Info`
(`docs/opencode-api.md:266`). `projects.js#fetchSessions` already fetches this
list and discards both fields. Today the app can only show the *current*
session's usage — there is no historical or per-project view anywhere.

Aggregate what is already in memory into spend-by-project, spend-by-day and top
sessions. No credentials, no PTY, no TrueFoundry dependency. Do this first
regardless of how the rest lands.

### Tier 2 — Gateway truth for cost and context

Query `metrics/query` grouped by model, cache the result, and use it to restore
real cost figures for TrueFoundry models and to backfill context limits into the
catalog so the context bar works again.

Routes over the same PTY + curl path as discovery, so it must be **on demand
with a TTL** — a PTY round-trip is create → token → WebSocket → teardown, far
too expensive to poll.

### Tier 3 — The usage view

A dedicated dialog: spend over time (`type: "timeseries"` with `interval`),
breakdown by model and by provider account, request volume
(`type: "distribution"`). The popover keeps its at-a-glance role for the live
session.

## Sequencing

1. A1 config schema (blocks the config writer)
2. A2 pure logic
3. A3 store wiring
4. A4 UI
5. B Tier 1 (independent — can land at any point)
6. A4 connection test
7. B Tier 2
8. B Tier 3

`npm run build` at each step. Playwright specs written alongside and left unrun,
per `CLAUDE.md`. Screenshots captured for the visual work.

## Testing approach

Per `CLAUDE.md`, PTY-backed paths get no mock — seed the store instead, the way
`test/mentions.spec.js` seeds its caches. `test/providers.spec.js` should cover
what the PDF's version did not: selection behaviour and generated config, not
just initial UI presence.

Cases: standard `{data: [...]}` discovery; Fortescue nested discovery; exclusion
of embedding and image models; provider-level select and deselect; partial
selection indeterminate state; empty selection disabling the add button;
generated config containing only selected IDs; unrelated existing JSON config
left intact; JSONC refusal.

## Risks and open questions

- **Config schema unverified** (A1). Highest-impact unknown.
- **Metrics API field names unverified** — docs unreachable from this container.
- **Control plane vs gateway host.** TrueFoundry docs say `{control_plane_url}`;
  Fortescue served `model/enabled` from the gateway host. Confirm whether one
  host serves both before assuming.
- **PAT scope for metrics.** A personal PAT may not carry metrics read scope
  even where it carries model-list scope.
- **Catalogue visibility is not callability** — addressed by the connection test.
- **`config.providers` assumed absent or an object.** A malformed existing
  config could throw on assignment; validate explicitly.
- **The config writer replaces the whole provider block**, which is required to
  drop deselected models but also discards hand-added headers or limits.
- **The PAT pasted in the prior session is compromised** and must be rotated
  before any live testing. Never reuse or reproduce it.

## What cannot be verified from this container

No OpenCode server is running and `gateway.ai.fortescue.com` is not reachable.
Live discovery, the restart-and-reconnect credential flow, a real inference
call, and any metrics query all need a local machine and a freshly rotated PAT.

## Outcome

Shipped across `lib/truefoundry.js`, `stores/providers.js`, `stores/usage.js`,
`components/dialogs/ProvidersDialog.vue`, `components/dialogs/UsageDialog.vue`
and `components/popovers/UsagePopover.vue`.

Two additions beyond the plan, both prompted by the constraint that PTY-backed
paths can't be mocked:

- **Discovery results are cached per gateway** in localStorage, the way `git.js`
  and `filesearch.js` cache theirs. Reopening the dialog no longer costs a PTY
  round-trip, and it gives the tests a seam to seed — the `mentions.spec.js`
  pattern.
- **The mock grew a `seed` object** separate from `control`. Control resets when
  a client opens the event stream, which is the same page load that fetches the
  session list, so a data seed kept in `control` could never be in effect for
  the fetch it was meant to shape.

Verified: `npm run build` clean; the full Playwright suite green at 45 tests,
including 11 new ones (7 for the TrueFoundry card, 4 for usage); desktop and
mobile screenshots captured against the mock.

Two visual defects were caught by screenshotting rather than by tests, which is
why the repo asks for pictures:

- The cost-by-day chart rendered **completely empty**. `.connect-panel` is a
  flex column, so the chart's fixed height was shrunk to its content and every
  bar's percentage height resolved against nothing. The test counted bar slots
  and passed against an invisible chart; it now asserts a bar has real height.
- The gateway URL truncated mid-host and the discover button wrapped to two
  lines at the dialog's 460px. The URL now takes its own row.

Still unverified, and still needing a live server plus a freshly rotated PAT:
discovery against a real tenant, the config write over PTY, the restart-and-
reconnect credential flow, the inference smoke test, and every field name in the
metrics API.

## References

- TrueFoundry, API Access to Agent Metrics — https://www.truefoundry.com/docs/ai-gateway/fetch-agent-metrics
- TrueFoundry, API Access to Logs — https://www.truefoundry.com/docs/ai-gateway/fetch-request-logs
- TrueFoundry, View Metrics — https://www.truefoundry.com/docs/ai-gateway/analytics
- TrueFoundry, Observability in AI Gateways — https://www.truefoundry.com/blog/observability-in-ai-gateway
