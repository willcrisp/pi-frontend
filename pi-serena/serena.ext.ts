import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOL_PREFIX = "mcp__serena__";

const SERENA_SYSTEM_PROMPT =
  "This project has Serena semantic code tools (`mcp__serena__*`). Prefer " +
  "Serena's `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, " +
  "and `search_for_pattern` for initial code exploration and navigation " +
  "before falling back to plain text search or reading whole files.";

export default function (pi: ExtensionAPI) {
  let client: Client | null = null;
  let connectAttempted = false;

  async function connectSerena(ctx: { ui?: { notify?: (msg: string, level?: string) => void } }) {
    if (connectAttempted) return;
    connectAttempted = true;

    const transport = new StdioClientTransport({
      command: "serena",
      args: ["start-mcp-server", "--context", "ide-assistant", "--project-from-cwd"],
    });

    const candidate = new Client({ name: "pi-serena-bridge", version: "0.1.0" }, { capabilities: {} });

    try {
      await candidate.connect(transport);
      const { tools } = await candidate.listTools();

      for (const tool of tools) {
        pi.registerTool({
          name: `${TOOL_PREFIX}${tool.name}`,
          description: tool.description ?? "",
          parameters: tool.inputSchema as Record<string, unknown>,
          execute: async (args: Record<string, unknown>) => {
            const result = await candidate.callTool({ name: tool.name, arguments: args });
            return result;
          },
        });
      }

      client = candidate;
      ctx.ui?.notify?.(`Serena connected: ${tools.length} tool(s) registered`, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui?.notify?.(
        `Serena not available, skipping semantic tools: ${message}`,
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
