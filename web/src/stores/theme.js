// Reactive UI-preference stores (color profile, message/thinking font size,
// content column width), each persisted to localStorage and applied to the
// document root as CSS custom properties — pure client-side theming, no
// server involvement. Consumed by ColorProfilePopover.vue.
//
// Key exports:
//   COLOR_FIELDS / colorProfile   — field definitions and the reactive palette
//     (key -> hex color); setColor(key, value) / resetColors()
//   fontSize / setFontSize(px)     — message text size (px)
//   thinkingSize / setThinkingSize(percent) / THINKING_SIZE_MIN / _MAX — thinking
//     text size as a percent of the regular message size
//   contentWidth / setContentWidth(px) / CONTENT_WIDTH_MIN / _MAX — max-width of
//     the message list / composer column
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
  {
    key: "toolSerena",
    label: "Serena tool call",
    cssVar: "--msg-tool-serena",
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

// Message font size (px), same persistence pattern as the color profile.
const FONT_SIZE_KEY = "pi-web:font-size";
const FONT_SIZE_DEFAULT = 14;
const FONT_SIZE_MIN = 11;
const FONT_SIZE_MAX = 22;

function loadStoredFontSize() {
  const raw = Number(localStorage.getItem(FONT_SIZE_KEY));
  return Number.isFinite(raw) && raw >= FONT_SIZE_MIN && raw <= FONT_SIZE_MAX
    ? raw
    : FONT_SIZE_DEFAULT;
}

export const fontSize = reactive({ px: loadStoredFontSize() });

function applyFontSize(px) {
  document.documentElement.style.setProperty("--msg-font-size", `${px}px`);
}

// Thinking text size as a percentage of the regular message size.
const THINKING_SIZE_KEY = "pi-web:thinking-size";
export const THINKING_SIZE_MIN = 60;
export const THINKING_SIZE_MAX = 100;
const THINKING_SIZE_DEFAULT = 85;

function loadStoredThinkingSize() {
  const raw = Number(localStorage.getItem(THINKING_SIZE_KEY));
  return Number.isFinite(raw) && raw >= THINKING_SIZE_MIN && raw <= THINKING_SIZE_MAX
    ? raw
    : THINKING_SIZE_DEFAULT;
}

export const thinkingSize = reactive({ percent: loadStoredThinkingSize() });

function applyThinkingSize(percent) {
  document.documentElement.style.setProperty("--thinking-font-scale", `${percent / 100}`);
}

export function setThinkingSize(percent) {
  thinkingSize.percent = Math.min(
    THINKING_SIZE_MAX,
    Math.max(THINKING_SIZE_MIN, Math.round(percent))
  );
}

applyThinkingSize(thinkingSize.percent);
watch(
  () => thinkingSize.percent,
  (percent) => {
    applyThinkingSize(percent);
    try {
      localStorage.setItem(THINKING_SIZE_KEY, String(percent));
    } catch {
      // storage unavailable — in-memory only
    }
  }
);

export function setFontSize(px) {
  fontSize.px = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, px));
}

applyFontSize(fontSize.px);
watch(
  () => fontSize.px,
  (px) => {
    applyFontSize(px);
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(px));
    } catch {
      // storage unavailable — in-memory only
    }
  }
);

// Content width (px), same persistence pattern as font size. This is a
// max-width applied to the message list / composer column — it only widens
// the content, never forces it wider than the viewport, since max-width
// still lets the (unset-width) block shrink to fit a narrow window.
const CONTENT_WIDTH_KEY = "pi-web:content-width";
const CONTENT_WIDTH_DEFAULT = 760;
export const CONTENT_WIDTH_MIN = 480;
export const CONTENT_WIDTH_MAX = 1400;

function loadStoredContentWidth() {
  const raw = Number(localStorage.getItem(CONTENT_WIDTH_KEY));
  return Number.isFinite(raw) &&
    raw >= CONTENT_WIDTH_MIN &&
    raw <= CONTENT_WIDTH_MAX
    ? raw
    : CONTENT_WIDTH_DEFAULT;
}

export const contentWidth = reactive({ px: loadStoredContentWidth() });

function applyContentWidth(px) {
  document.documentElement.style.setProperty("--content-width", `${px}px`);
}

export function setContentWidth(px) {
  contentWidth.px = Math.min(
    CONTENT_WIDTH_MAX,
    Math.max(CONTENT_WIDTH_MIN, Math.round(px))
  );
}

applyContentWidth(contentWidth.px);
watch(
  () => contentWidth.px,
  (px) => {
    applyContentWidth(px);
    try {
      localStorage.setItem(CONTENT_WIDTH_KEY, String(px));
    } catch {
      // storage unavailable — in-memory only
    }
  }
);
