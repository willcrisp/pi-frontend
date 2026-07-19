import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type Mode = "build" | "plan";

const MODE_PROMPTS: Record<Mode, string> = {
  build:
    "You are in Build mode. Implement the requested changes directly: make " +
    "the necessary edits, run relevant tests or builds, and keep changes " +
    "focused and minimal. Prefer taking action over describing what should " +
    "be done.",
  plan:
    "You are in Plan mode. Do not modify any files. Research the codebase, " +
    "identify the relevant files and constraints, and produce a concise " +
    "step-by-step implementation plan. Wait for explicit approval before " +
    "making any changes.",
};

const MODE_ENTRY_TYPE = "mode-selection";

function isMode(value: string): value is Mode {
  return value === "build" || value === "plan";
}

export default function (pi: ExtensionAPI) {
  let activeMode: Mode | null = null;

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE) {
        activeMode = (entry.data as { mode: Mode | null }).mode;
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${MODE_PROMPTS[activeMode]}`,
    };
  });

  pi.registerCommand("mode", {
    description:
      "Set the active mode (build, plan, none). The matching system prompt " +
      "is silently applied to every turn until you change it again.",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const options = ["build", "plan", "none"];
      return options
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }));
    },
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();

      if (value === "" || value === "none") {
        activeMode = null;
        pi.appendEntry(MODE_ENTRY_TYPE, { mode: null });
        ctx.ui.notify("Mode cleared", "info");
        return;
      }

      if (!isMode(value)) {
        ctx.ui.notify(`Unknown mode "${value}". Use build, plan, or none.`, "error");
        return;
      }

      activeMode = value;
      pi.appendEntry(MODE_ENTRY_TYPE, { mode: value });
      ctx.ui.notify(`Mode set to ${value}`, "info");
    },
  });
}
