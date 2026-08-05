// The names of the MCP servers configured on the target, from `GET /mcp`.
//
// Just the names, and just for the transcript. Servers name their tools
// `<server>_<tool>` (`serena_find_referencing_symbols`), so the prefix says which
// server a call came from — but only if you know which prefixes are servers.
// MessageView uses that to attribute a tool call and drop the prefix from its
// label. The list used to be a literal in that component
// (`const MCP_SERVERS = ["serena"]`): one deployment's configuration compiled
// into a view, where a second server meant editing a component and nobody else's
// install matched.
//
// McpDialog.vue deliberately does NOT read this. It fetches the same route
// itself because it needs what this drops — per-server status, per-server errors,
// and a 404 distinguished from a failure so it can say "this build doesn't expose
// it" rather than "no servers".
//
// Which is also why nothing here reports an error: the route is absent on some
// builds, and a tool call renders perfectly well under its full name. Every
// failure resolves to an empty list.
import { reactive } from "vue";
import { apiGet, unwrap } from "../lib/api.js";

// Not exported: `mcpServerOf` is the whole interface. Reactive so a transcript
// rendered before the fetch lands re-renders when it does.
const mcpStore = reactive({
  names: [], // string[], server names as declared in config
});

function namesFrom(payload) {
  const body = unwrap(payload);
  if (Array.isArray(body)) return body.map((s) => s && (s.name || s.id)).filter(Boolean);
  if (body && typeof body === "object") return Object.keys(body);
  return [];
}

// Called once from initOpenCode(), and again whenever the stream reconnects —
// the config is read at server startup, so a reconnect is the cue that it may
// have changed.
export async function loadMcpServers() {
  try {
    const res = await apiGet("/mcp");
    mcpStore.names = res.ok ? namesFrom(await res.json()) : [];
  } catch {
    mcpStore.names = [];
  }
}

// The server a tool call came from, or null for a built-in. Longest prefix wins,
// so a server named `git` can't shadow one named `git_remote`.
export function mcpServerOf(toolName) {
  if (!toolName) return null;
  let best = null;
  for (const name of mcpStore.names) {
    if (toolName.startsWith(name + "_") && (!best || name.length > best.length)) best = name;
  }
  return best;
}
