// Usage accounting across sessions, and the gateway's own figures.
//
// Two tiers, answering different questions:
//
//   1. **Local history** — every session's cost and tokens, aggregated from the
//      session list the app already fetches. `GET /api/session` meters each
//      SessionV2.Info, so the whole history is in memory the moment the sidebar
//      loads; nothing here costs a request. `stores/opencode/context.js` owns
//      the *live* session's accounting and this module deliberately doesn't
//      touch it — that one is per-turn and server-confirmed, this one is
//      historical.
//
//   2. **Gateway truth** — TrueFoundry's metrics API. This exists because a
//      custom provider is configured without pricing or context limits, so
//      OpenCode has nothing to compute a cost from and reports 0 for every
//      TrueFoundry model. Local totals silently under-report the moment a
//      tenant's models are in use; the gateway is the only thing that knows.
//
// The gateway half runs over PTY + curl, exactly like discovery in
// providers.js: the control plane needn't send CORS headers and Radius has no
// backend. A PTY round-trip is create → token → WebSocket → teardown, far too
// expensive to poll, so results are cached and only refreshed on demand.
import { reactive } from "vue";
import { projectsStore, activeSessionDirectory, directoryLabel } from "./projects.js";
import { runScript, shellQuote } from "./pty.js";
import { opencodeStore } from "./opencode.js";
import { TRUEFOUNDRY_PROVIDER_ID } from "../lib/truefoundry.js";
import { loadEnvPAT, resolvePAT } from "./providers.js";

const STATUS_MARKER = "__OC_CURL_STATUS__";
// Long enough that reopening the panel is instant, short enough that a figure
// on screen is never badly stale.
const CACHE_TTL_MS = 5 * 60 * 1000;

export const usageStore = reactive({
  gateway: {
    busy: false,
    error: null,
    fetchedAt: 0,
    byModel: [], // [{ model, cost, tokens, requests }]
    series: [], // [{ ts, cost, tokens }]
  },
});

// --- Tier 1: local history --------------------------------------------------

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== "object") return 0;
  const cache = tokens.cache || {};
  return (
    (tokens.input || 0) + (tokens.output || 0) + (cache.read || 0) + (cache.write || 0)
  );
}

function dayKey(ts) {
  if (!ts) return "";
  // Timestamps arrive in ms on every build seen so far, but a seconds-based one
  // would land in 1970 and quietly ruin the chart, so normalize by magnitude.
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toISOString().slice(0, 10);
}

// One session's cumulative figures as the SERVER has them, off its own
// SessionV2.Info record — the same source the usage view reads.
//
// This exists because the header popover and the usage dialog were showing two
// different numbers for the same session at the same time: the popover reads
// stores/opencode/context.js, which is built from the events of the current page
// load and so reads 0 until a turn streams, while the dialog reads these
// cumulative totals. Both were right and neither said which it was. The popover
// now falls back to this and labels which one is on screen.
export function serverSessionTotals(sessionID) {
  const s = (projectsStore.sessions || []).find((x) => x.id === sessionID);
  if (!s) return null;
  const cache = s.tokens?.cache || {};
  return {
    cost: s.cost || 0,
    tokens: {
      input: s.tokens?.input || 0,
      output: s.tokens?.output || 0,
      cacheRead: cache.read || 0,
      cacheWrite: cache.write || 0,
      total: tokenTotal(s.tokens),
    },
  };
}

// Everything the usage view needs, derived from the session list in memory.
// Sub-agent sessions are counted: they are metered separately from their parent
// and their spend is additive, never a double-count (docs/subagents-alfuat.md).
export function localUsage() {
  const sessions = projectsStore.sessions || [];

  let cost = 0;
  let tokens = 0;
  const byProject = new Map();
  const byDay = new Map();

  for (const s of sessions) {
    const sessionTokens = tokenTotal(s.tokens);
    cost += s.cost || 0;
    tokens += sessionTokens;

    const dir = s.directory || "";
    const project = byProject.get(dir) || {
      directory: dir,
      label: directoryLabel(dir) || "unknown",
      cost: 0,
      tokens: 0,
      sessions: 0,
    };
    project.cost += s.cost || 0;
    project.tokens += sessionTokens;
    project.sessions += 1;
    byProject.set(dir, project);

    const day = dayKey(s.updatedAt);
    if (day) {
      const bucket = byDay.get(day) || { day, cost: 0, tokens: 0, sessions: 0 };
      bucket.cost += s.cost || 0;
      bucket.tokens += sessionTokens;
      bucket.sessions += 1;
      byDay.set(day, bucket);
    }
  }

  const top = [...sessions]
    .map((s) => ({
      id: s.id,
      title: s.title,
      cost: s.cost || 0,
      tokens: tokenTotal(s.tokens),
      directory: s.directory,
    }))
    .filter((s) => s.cost > 0 || s.tokens > 0)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
    .slice(0, 8);

  return {
    cost,
    tokens,
    sessions: sessions.length,
    byProject: [...byProject.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    top,
  };
}

// True when the catalog serves models from a provider that reports no cost, so
// the view can say why its totals look low instead of just showing $0.00.
export function hasUnpricedModels() {
  return (opencodeStore.availableModels || []).some(
    (m) => m.providerID === TRUEFOUNDRY_PROVIDER_ID
  );
}

// --- Tier 2: gateway metrics ------------------------------------------------

// POST a metrics query to the TrueFoundry control plane, over the host shell.
// Same PAT handling rules as providers.js#gatewayJSON: stdin config, never argv,
// never persisted.
async function metricsQuery(cwd, origin, pat, body) {
  if (!/^[A-Za-z0-9._~-]+$/.test(pat)) throw new Error("PAT contains invalid characters");

  const dataFile = `/tmp/oc-usage-${Math.random().toString(36).slice(2, 10)}.json`;
  const curlConfig =
    `header = "Authorization: Bearer ${pat}"\n` +
    `header = "Content-Type: application/json"\n` +
    `url = "${origin}/api/svc/v1/llm-gateway/metrics/query"\n` +
    `request = "POST"\n` +
    `data = "@${dataFile}"\n`;

  const script = [
    `printf %s ${shellQuote(JSON.stringify(body))} > ${shellQuote(dataFile)}`,
    `printf %s ${shellQuote(curlConfig)} | ` +
      `curl --silent --show-error --fail-with-body --max-time 30 --config -; ` +
      `printf '\\n${STATUS_MARKER}%s' "$?"`,
    `rm -f ${shellQuote(dataFile)}`,
  ].join("\n");

  const out = await runScript(cwd, script, {
    timeoutMs: 45000,
    title: "harness: TrueFoundry usage",
  });

  const at = out.lastIndexOf(STATUS_MARKER);
  const status = at === -1 ? "" : out.slice(at + STATUS_MARKER.length).trim();
  const payload = (at === -1 ? out : out.slice(0, at)).trim();
  if (status !== "0") throw new Error("TrueFoundry rejected the usage request");
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("Usage endpoint returned a non-JSON response");
  }
}

// Pull a number out of a result row whatever the column ended up being called.
// The response shape isn't pinned down in anything this repo can verify, so
// read tolerantly rather than assume — a wrong guess would show a confident
// wrong number, which is worse than showing nothing.
function pick(row, names) {
  for (const name of names) {
    const v = row[name];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function rowsOf(payload) {
  const d = (payload && (payload.data || payload)) || {};
  for (const key of ["results", "rows", "data", "series"]) {
    if (Array.isArray(d[key])) return d[key];
  }
  return Array.isArray(d) ? d : [];
}

// Gateway usage for the last `days`, grouped by model. Cached; pass
// `{force: true}` to bypass.
export async function refreshGatewayUsage(gateway, typedPAT, { days = 30, force = false } = {}) {
  const state = usageStore.gateway;
  if (!force && state.fetchedAt && Date.now() - state.fetchedAt < CACHE_TTL_MS) return true;
  if (state.busy) return false;

  state.busy = true;
  state.error = null;
  try {
    // Same read-through as discovery: a PAT already in the host's .env means
    // the usage panel works without re-typing it here too.
    await loadEnvPAT();
    const pat = resolvePAT(typedPAT);
    if (!pat) {
      throw new Error("Enter a TrueFoundry PAT, or set TRUEFOUNDRY_API_KEY in .env");
    }
    const origin = new URL(gateway).origin;
    const cwd = activeSessionDirectory() || undefined;
    const endTs = Date.now();
    const startTs = endTs - days * 24 * 60 * 60 * 1000;

    const distribution = await metricsQuery(cwd, origin, pat, {
      startTs,
      endTs,
      datasource: "modelMetrics",
      type: "distribution",
      aggregations: [
        { type: "sum", column: "cost" },
        { type: "sum", column: "totalTokens" },
        { type: "count", column: "requests" },
      ],
      groupBy: ["modelName"],
    });

    state.byModel = rowsOf(distribution)
      .map((row) => ({
        model: row.modelName || row.model || row.group || "unknown",
        cost: pick(row, ["cost", "sum_cost", "totalCost"]),
        tokens: pick(row, ["totalTokens", "sum_totalTokens", "tokens"]),
        requests: pick(row, ["requests", "count", "count_requests"]),
      }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

    const timeseries = await metricsQuery(cwd, origin, pat, {
      startTs,
      endTs,
      datasource: "modelMetrics",
      type: "timeseries",
      interval: "1 day",
      aggregations: [
        { type: "sum", column: "cost" },
        { type: "sum", column: "totalTokens" },
      ],
    });

    state.series = rowsOf(timeseries).map((row) => ({
      ts: row.ts || row.timestamp || row.time || 0,
      cost: pick(row, ["cost", "sum_cost"]),
      tokens: pick(row, ["totalTokens", "sum_totalTokens", "tokens"]),
    }));

    state.fetchedAt = Date.now();
    return true;
  } catch (err) {
    state.error = err.message || "Could not load gateway usage";
    return false;
  } finally {
    state.busy = false;
  }
}

// Gateway cost for the models this session used, when the local figure is 0
// because the provider carries no pricing. Returns null when there's nothing
// better to show, so callers can leave the local number alone.
export function gatewayCostFor(modelIDs) {
  const rows = usageStore.gateway.byModel;
  if (!rows.length || !modelIDs || !modelIDs.length) return null;
  let sum = 0;
  let matched = false;
  for (const row of rows) {
    if (modelIDs.some((id) => id && row.model && row.model.includes(id))) {
      sum += row.cost;
      matched = true;
    }
  }
  return matched ? sum : null;
}
