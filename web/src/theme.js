import { reactive, watch } from "vue";

// Color profile: a user-editable color for each type of message/content block
// that can appear in the chat. Each entry maps to a CSS custom property that
// style.css consumes (see the "color profile" vars in :root and the message /
// tool / usage rules that reference them). Colors are persisted to
// localStorage and re-applied to the document root on load, so a customized
// palette survives reloads without any server involvement.
export const COLOR_FIELDS = [
  {
    key: "user",
    label: "User message",
    cssVar: "--msg-user",
    default: "#7aa2f7",
  },
  {
    key: "assistant",
    label: "Assistant text",
    cssVar: "--msg-assistant",
    default: "#d7dade",
  },
  {
    key: "thinking",
    label: "Thinking",
    cssVar: "--msg-thinking",
    default: "#7c848c",
  },
  {
    key: "tool",
    label: "Tool call",
    cssVar: "--msg-tool",
    default: "#7aa2f7",
  },
  {
    key: "toolError",
    label: "Tool error",
    cssVar: "--msg-tool-error",
    default: "#f7768e",
  },
  {
    key: "subagent",
    label: "Sub-agent",
    cssVar: "--msg-subagent",
    default: "#bb9af7",
  },
];

const STORAGE_KEY = "pi-web:color-profile";

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function defaults() {
  return Object.fromEntries(COLOR_FIELDS.map((f) => [f.key, f.default]));
}

// Reactive palette: defaults overlaid with any persisted overrides. Unknown
// keys in storage are ignored; missing keys fall back to their default.
const stored = loadStored();
export const colorProfile = reactive({ ...defaults(), ...pick(stored) });

function pick(obj) {
  const out = {};
  for (const f of COLOR_FIELDS) {
    if (typeof obj[f.key] === "string") out[f.key] = obj[f.key];
  }
  return out;
}

function apply(profile) {
  const root = document.documentElement;
  for (const f of COLOR_FIELDS) {
    root.style.setProperty(f.cssVar, profile[f.key] || f.default);
  }
}

export function setColor(key, value) {
  if (key in colorProfile) colorProfile[key] = value;
}

export function resetColors() {
  Object.assign(colorProfile, defaults());
}

// Apply immediately and on every change; persist changes.
apply(colorProfile);
watch(
  colorProfile,
  (p) => {
    apply(p);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...p }));
    } catch {
      // storage unavailable (private mode / quota) — in-memory only
    }
  },
  { deep: true }
);
