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
import { readJSON, writeJSON, readNumber, writeString } from "../lib/storage.js";

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

function defaults() {
  return Object.fromEntries(COLOR_FIELDS.map((f) => [f.key, f.default]));
}

// Reactive palette: defaults overlaid with any persisted overrides. Unknown
// keys in storage are ignored; missing keys fall back to their default.
const stored = readJSON(STORAGE_KEY, {}) || {};
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
    writeJSON(STORAGE_KEY, { ...p });
  },
  { deep: true }
);

// --- Numeric preferences -----------------------------------------------------
// Font size, thinking-text scale and content width are the same thing three
// times over: a clamped number, restored from localStorage, written to a CSS
// custom property, and persisted on change. They are built from one factory so
// the behaviour can't drift between them — and so adding a fourth is a single
// entry below rather than another thirty-line copy.
//
// `prop` is the key on the returned reactive object, kept per-preference
// because the popover binds `fontSize.px` and `thinkingSize.percent` by name.
// `toCss` maps the stored number to the custom property's value.
function numericPreference({ key, min, max, fallback, prop, cssVar, toCss }) {
  const clamp = (value) => Math.min(max, Math.max(min, Math.round(value)));

  const stored = readNumber(key, NaN);
  const state = reactive({
    [prop]: Number.isFinite(stored) && stored >= min && stored <= max ? stored : fallback,
  });

  const apply = (value) =>
    document.documentElement.style.setProperty(cssVar, toCss ? toCss(value) : `${value}px`);

  apply(state[prop]);
  watch(
    () => state[prop],
    (value) => {
      apply(value);
      writeString(key, value);
    }
  );

  return [state, (value) => (state[prop] = clamp(value))];
}

// Message font size (px).
export const [fontSize, setFontSize] = numericPreference({
  key: "pi-web:font-size",
  min: 11,
  max: 22,
  fallback: 14,
  prop: "px",
  cssVar: "--msg-font-size",
});

// Thinking text size as a percentage of the regular message size.
export const THINKING_SIZE_MIN = 60;
export const THINKING_SIZE_MAX = 100;
export const [thinkingSize, setThinkingSize] = numericPreference({
  key: "pi-web:thinking-size",
  min: THINKING_SIZE_MIN,
  max: THINKING_SIZE_MAX,
  fallback: 85,
  prop: "percent",
  cssVar: "--thinking-font-scale",
  toCss: (percent) => `${percent / 100}`,
});

// Content width (px). This is a max-width applied to the message list /
// composer column — it only widens the content, never forces it wider than the
// viewport, since max-width still lets the (unset-width) block shrink to fit a
// narrow window.
export const CONTENT_WIDTH_MIN = 480;
export const CONTENT_WIDTH_MAX = 1400;
export const [contentWidth, setContentWidth] = numericPreference({
  key: "pi-web:content-width",
  min: CONTENT_WIDTH_MIN,
  max: CONTENT_WIDTH_MAX,
  fallback: 760,
  prop: "px",
  cssVar: "--content-width",
});
