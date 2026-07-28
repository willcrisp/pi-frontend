// Slash-command autocomplete: server commands + skills (both from the opencode
// store) plus local builtins, matched while the composer holds just "/query".
//
// Unlike @-mentions, a slash command is only ever the whole box, so the menu is
// derived straight from `input` rather than tracked off the caret.
import { computed, nextTick, ref, watch } from "vue";
import { opencodeStore as store } from "../stores/opencode.js";
import { activeSessionDirectory, startNewChat } from "../stores/projects.js";

// Builtins run against the harness itself instead of going to the server.
const BUILTIN_SLASH_COMMANDS = [{ name: "new", description: "new session in this project" }];

function runBuiltinCommand(name) {
  if (name === "new") {
    startNewChat(activeSessionDirectory() || undefined).catch(() => {});
  }
}

export function useSlashCommands(input, textareaEl) {
  const allCommands = computed(() => {
    const dynamic = store.commands.map((c) => ({
      name: c.name,
      description: c.description || "",
      source: "command",
    }));
    const skills = store.skills.map((s) => ({
      name: s.name || s.id,
      description: s.description || "",
      source: "skill",
    }));
    const builtin = BUILTIN_SLASH_COMMANDS.map((c) => ({ ...c, source: "builtin" }));
    return [...dynamic, ...skills, ...builtin];
  });

  const matches = computed(() => {
    const m = /^\/(\S*)$/.exec(input.value);
    if (!m) return [];
    const query = m[1].toLowerCase();
    return allCommands.value.filter((c) => c.name && c.name.toLowerCase().startsWith(query));
  });

  const open = computed(() => matches.value.length > 0);
  const index = ref(0);

  watch(matches, () => {
    index.value = 0;
  });

  function choose(cmd) {
    if (!cmd) return;
    if (cmd.source === "builtin") {
      input.value = "";
      runBuiltinCommand(cmd.name);
      return;
    }
    input.value = `/${cmd.name} `;
    nextTick(() => textareaEl.value?.focus());
  }

  // Escape clears the whole box, because the box *is* the query here.
  function escape() {
    input.value = "";
  }

  return { menu: { open, matches, index, choose, escape }, allCommands, runBuiltinCommand };
}
