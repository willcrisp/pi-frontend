import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TOOL_PREFIX = "mcp__serena__";
const PORT_FILE = ".serena/pi-web-port";

const SERENA_SYSTEM_PROMPT =
  "This project has Serena semantic code tools (`mcp__serena__*`). Prefer " +
  "Serena's `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, " +
  "and `search_for_pattern` for initial code exploration and navigation " +
  "before falling back to plain text search or reading whole files.";

export default function (pi: ExtensionAPI) {
  let client: Client | null = null;
  let connectAttempted = false;

  async function readPort(): Promise<number | null> {
    try {
      // pi's own process cwd is always the project path (pi-web always
      // spawns it with current_dir set that way — see server/src/main.rs),
      // so this is the same directory `serena-daemon.sh <project-path>` was
      // pointed at.
      const raw = await readFile(join(process.cwd(), PORT_FILE), "utf8");
      const port = parseInt(raw.trim(), 10);
      return Number.isFinite(port) && port > 0 ? port : null;
    } catch {
      // No port file — the common case: this project has no persistent
      // Serena instance running (or serena-daemon.sh was never run for it).
      // Deliberately silent, not a notify(), so this doesn't spam every turn.
      return null;
    }
  }

  async function connectSerena(ctx: { ui?: { notify?: (msg: string, level?: string) => void } }) {
    if (connectAttempted) return;
    connectAttempted = true;

    const port = await readPort();
    if (port == null) return;

    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
    const candidate = new Client({ name: "pi-serena-bridge", version: "0.2.0" }, { capabilities: {} });

    try {
      await candidate.connect(transport);
      const { tools } = await candidate.listTools();

      for (const tool of tools) {
        pi.registerTool({
          name: `${TOOL_PREFIX}${tool.name}`,
          description: tool.description ?? "",
          parameters: tool.inputSchema as Record<string, unknown>,
          execute: async (args: Record<string, unknown>) => {
            try {
              return await candidate.callTool({ name: tool.name, arguments: args });
            } catch (err) {
              // The persistent instance may have been killed/restarted since
              // we connected (stale port file, systemd restart, ...). Drop
              // the cached client so the next turn's before_agent_start
              // reconnects instead of staying wedged on a dead connection.
              client = null;
              connectAttempted = false;
              throw err;
            }
          },
        });
      }

      client = candidate;
      ctx.ui?.notify?.(`Serena connected: ${tools.length} tool(s) registered`, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui?.notify?.(
        `Found a Serena port file but couldn't connect (is the instance still running?): ${message}`,
        "warning",
      );
    }
  }

  pi.on("before_agent_start", async (event, ctx) => {
    await connectSerena(ctx);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${SERENA_SYSTEM_PROMPT}`,
    };
  });

  pi.on("session_end", async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
  });
}
