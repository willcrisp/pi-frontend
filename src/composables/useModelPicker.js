// The composer's three SelectMenu popovers — agent, model, reasoning effort —
// and the Ctrl/Cmd+arrow shortcuts that step them.
//
// This is presentation over the opencode store: it decides grouping, ordering
// and colour, and writes back through setModel/setThinkingLevel. All three
// panels open upward, so every list here is built to read bottom-up (the option
// nearest the trigger is the weakest/lowest).
import { computed, onBeforeUnmount, onMounted } from "vue";
import { opencodeStore as store, setModel, setThinkingLevel } from "../stores/opencode.js";
import { hiddenModels, modelKey } from "../stores/modelfilter.js";

// Desaturated pastel gradient, cool blue (low effort) to warm red (max effort),
// tuned light enough to read on the dark theme.
const THINKING_COLORS = {
  off: "hsl(215 38% 72%)",
  minimal: "hsl(190 36% 68%)",
  low: "hsl(160 34% 65%)",
  medium: "hsl(110 32% 64%)",
  high: "hsl(70 38% 64%)",
  xhigh: "hsl(35 42% 66%)",
  max: "hsl(5 46% 70%)",
};

// Named steps of the same scale, used to colour the model list: the weakest
// model reads as "low" reasoning, the strongest as "max".
const MODEL_RAMP = ["low", "medium", "high", "xhigh", "max"];

function rampColor(i, n) {
  const t = n > 1 ? i / (n - 1) : 1;
  return THINKING_COLORS[MODEL_RAMP[Math.round(t * (MODEL_RAMP.length - 1))]];
}

// Explicit capability ranking, strongest first — the server's own ordering
// doesn't encode a tier, so the picker sorts on this. Matched as a substring of
// the model label/id (case-insensitive); anything unranked sorts below the
// ranked models, in the order the server gave.
const MODEL_RANK = ["sol", "terra", "luna"];

function modelRank(m) {
  const haystack = `${m.label || ""} ${m.modelID || ""}`.toLowerCase();
  const i = MODEL_RANK.findIndex((name) => haystack.includes(name));
  return i < 0 ? MODEL_RANK.length : i;
}

// Strongest at the top, weakest at the bottom.
function sortByRank(models) {
  return models
    .map((m, i) => ({ m, i, rank: modelRank(m) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.m);
}

function groupByProvider(models) {
  const groups = new Map();
  for (const m of models) {
    const key = m.providerID || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()];
}

export function useModelPicker() {
  const selectedModelKey = computed(() =>
    store.selectedModel ? `${store.selectedModel.providerID}:${store.selectedModel.modelID}` : ""
  );

  // UI-only model filter (state shared with the header's ModelFilterPopover):
  // hidden models are dropped from the picker, but a hidden model that is
  // currently selected stays visible so the select never shows a value that
  // isn't in its option list.
  const visibleModels = computed(() =>
    store.availableModels.filter(
      (m) => !hiddenModels.value.has(modelKey(m)) || modelKey(m) === selectedModelKey.value
    )
  );

  const modelGroups = computed(() =>
    groupByProvider(visibleModels.value).map(([provider, models]) => {
      const sorted = sortByRank(models);
      return {
        label: provider,
        options: sorted.map((m, i) => ({
          value: modelKey(m),
          label: m.label,
          // Weakest model gets the "low" reasoning colour, strongest gets "max".
          color: rampColor(sorted.length - 1 - i, sorted.length),
        })),
      };
    })
  );

  const selectedModelColor = computed(() => {
    for (const g of modelGroups.value) {
      const hit = g.options.find((o) => o.value === selectedModelKey.value);
      if (hit) return hit.color;
    }
    return "";
  });

  const agentGroups = computed(() => [
    {
      label: "",
      options: store.availableAgents.map((a) => ({
        value: a.id || a.name,
        label: a.name,
        title: a.description,
      })),
    },
  ]);

  function onModelChange(value) {
    if (!value) return;
    const sep = value.indexOf(":");
    setModel({ providerID: value.slice(0, sep), modelID: value.slice(sep + 1) });
  }

  // Reasoning-effort variants come from the selected model's Model.Info.variants
  // (empty on models — or servers — without them; the select is hidden then).
  const thinkingLevels = computed(() => {
    const m = store.selectedModel;
    const info = m
      ? store.availableModels.find((x) => x.providerID === m.providerID && x.modelID === m.modelID)
      : null;
    return info ? info.variants : [];
  });

  // Variant names not in THINKING_COLORS get a colour from the same gradient by
  // their position in the model's list, so any server-provided naming still
  // reads cool-to-warm.
  function thinkingColor(level) {
    if (!level) return "inherit";
    if (THINKING_COLORS[level]) return THINKING_COLORS[level];
    const levels = thinkingLevels.value;
    const i = levels.indexOf(level);
    if (i < 0) return "inherit";
    const t = levels.length > 1 ? i / (levels.length - 1) : 0;
    return `hsl(${Math.round(215 - t * 210)} 38% 68%)`;
  }

  const thinkingGroups = computed(() => [
    {
      label: "",
      // Displayed highest-effort first so the list reads bottom-up (low at the
      // bottom, nearest the trigger) in the upward-opening panel.
      options: [...thinkingLevels.value].reverse().map((level) => ({
        value: level,
        label: level,
        color: thinkingColor(level),
      })),
    },
  ]);

  // Ctrl/Cmd+ArrowUp/Down steps through the current model's variants;
  // Ctrl/Cmd+ArrowLeft/Right steps through the models themselves.
  function onSelectShortcut(e) {
    if (!(e.ctrlKey || e.metaKey)) return;

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const levels = thinkingLevels.value;
      if (levels.length <= 1) return;

      const current = levels.indexOf(store.thinkingLevel || "");
      const index = current < 0 ? 0 : current;
      const next = e.key === "ArrowUp" ? index + 1 : index - 1;
      if (next < 0 || next >= levels.length) return;

      e.preventDefault();
      setThinkingLevel(levels[next]);
      return;
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // Walk the picker's own order, weakest first, so Right steps up a tier —
      // the same direction Ctrl+Up steps reasoning.
      const keys = modelGroups.value.flatMap((g) => g.options.map((o) => o.value)).reverse();
      if (keys.length <= 1) return;

      const current = keys.indexOf(selectedModelKey.value);
      const index = current < 0 ? 0 : current;
      const next = e.key === "ArrowRight" ? index + 1 : index - 1;
      if (next < 0 || next >= keys.length) return;

      e.preventDefault();
      onModelChange(keys[next]);
    }
  }

  onMounted(() => window.addEventListener("keydown", onSelectShortcut));
  onBeforeUnmount(() => window.removeEventListener("keydown", onSelectShortcut));

  return {
    agentGroups,
    modelGroups,
    selectedModelKey,
    selectedModelColor,
    onModelChange,
    thinkingLevels,
    thinkingGroups,
    thinkingColor,
  };
}
