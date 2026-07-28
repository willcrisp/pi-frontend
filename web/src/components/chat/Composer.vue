<!--
  Composer component for OpenCode V2: handles text input, agent/model/reasoning
  selects (agent first, models grouped by provider, reasoning options from the
  selected model's variants), D20 die fidget toy, file
  attachments (paste, drag-and-drop, or the paperclip picker — images preview as
  thumbnails and can be marked up with the hover pencil, see ImageAnnotator),
  send prompt & abort actions.
  While a run is streaming the send arrow is replaced by stop, and the steer
  icon appears beside it: it sends the same box into the run that is already
  going, for the agent to read at its next turn (Enter does the same thing —
  see submit()).
  Ctrl/Cmd+ArrowUp/Down steps the reasoning variant, Ctrl/Cmd+ArrowLeft/Right
  steps the model (over the same filtered list the picker shows). The selects
  are themed SelectMenu popovers that open upward. The textarea placeholder
  cycles a random sci-fi/fantasy quote per mount (SCI_FI_QUOTES).
  "/" at the start of an empty box and "@" anywhere in it both open a fuzzy
  menu above the composer (slash commands/skills, and file paths from
  filesearch.js respectively) — see slashMatches/mentionMatches. A chosen
  "@path" is inserted as plain text; the server has no in-text mention
  resolution in this build (confirmed inert for `@agent`, see
  docs/subagents-v2.md), so it's a typing convenience only — the agent reads
  the path with its own tools same as if the user had typed it by hand.
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  opencodeStore as store,
  sendPrompt,
  sendSteer,
  abortSession,
  setModel,
  setAgent,
  setThinkingLevel,
  runCommand,
} from "../../stores/opencode.js";
import { startNewChat, activeSessionDirectory } from "../../stores/projects.js";
import { filesFor, refreshFiles } from "../../stores/filesearch.js";
import { fuzzyScore } from "../../lib/fuzzy.js";
import { hiddenModels, modelKey } from "../../stores/modelfilter.js";
import D20Die from "./D20Die.vue";
import SelectMenu from "./SelectMenu.vue";
import SteerButton from "./SteerButton.vue";
import ImageAnnotator from "../dialogs/ImageAnnotator.vue";

const input = ref("");
const textareaEl = ref(null);
const fileInputEl = ref(null);

// Attachments live only until the prompt is sent. Each entry is a FilePart
// (`{filename, mime, url}` with a base64 data URL) plus a local `id` for keying
// and an object URL for the thumbnail.
const attachments = ref([]);
const dragging = ref(false);
let attachmentSeq = 0;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (!file) continue;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      store.error = `${file.name || "Attachment"} is too large (max 10 MB)`;
      continue;
    }
    try {
      const url = await readAsDataUrl(file);
      attachments.value.push({
        id: `att-${attachmentSeq++}`,
        // Pasted screenshots arrive as a nameless blob; give them something readable.
        filename: file.name || `pasted-${Date.now()}.${(file.type.split("/")[1] || "bin")}`,
        mime: file.type || "application/octet-stream",
        url,
      });
    } catch (err) {
      store.error = `Could not read ${file.name || "attachment"}: ${err.message}`;
    }
  }
}

function removeAttachment(id) {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

// Only intercept a paste that actually carries files — plain text paste stays
// native so undo history and cursor position behave normally.
function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
}

function onDrop(e) {
  dragging.value = false;
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
}

function onDragOver(e) {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  dragging.value = true;
}

function onPickFiles(e) {
  addFiles([...e.target.files]);
  e.target.value = "";
}

function isImage(att) {
  return att.mime.startsWith("image/");
}

// Image markup: the pencil on an image chip opens ImageAnnotator, and saving
// replaces that attachment's data URL with the flattened PNG (always PNG, since
// the annotator re-encodes through a canvas).
const annotatingId = ref("");

const annotating = computed(() => attachments.value.find((a) => a.id === annotatingId.value) || null);

function onAnnotated(dataUrl) {
  const att = annotating.value;
  if (att) {
    att.url = dataUrl;
    att.mime = "image/png";
    att.filename = att.filename.replace(/\.[^.]+$/, "") + ".png";
  }
  annotatingId.value = "";
}

const sending = computed(() => store.isStreaming);

const SCI_FI_QUOTES = [
  "I must not fear. Fear is the mind-killer. — Dune",
  "It is by will alone I set my mind in motion. — Dune",
  "The ships hung in the sky in much the same way that bricks don't. — The Hitchhiker's Guide to the Galaxy",
  "Space is big. You just won't believe how vastly, hugely, mind-bogglingly big it is. — The Hitchhiker's Guide to the Galaxy",
  "Don't Panic. — The Hitchhiker's Guide to the Galaxy",
  "The sky above the port was the color of television, tuned to a dead channel. — Neuromancer",
  "So it goes. — Slaughterhouse-Five",
  "All this happened, more or less. — Slaughterhouse-Five",
  "Violence is the last refuge of the incompetent. — Foundation",
  "The enemy's gate is down. — Ender's Game",
  "That is not dead which can eternal lie. — At the Mountains of Madness",
  "Life before death. Strength before weakness. Journey before destination. — The Way of Kings",
  "The most important step a man can take is the next one. — Oathbringer",
  "Journey before destination. — Words of Radiance",
  "I've a hankering to be a hero. — Mistborn: The Final Empire",
  "There's always another secret. — Mistborn: The Well of Ascension",
  "Not all those who wander are lost. — The Fellowship of the Ring",
  "All we have to decide is what to do with the time that is given us. — The Fellowship of the Ring",
  "It's a dangerous business, going out your door. — The Hobbit",
  "A wizard is never late. — The Fellowship of the Ring",
  "The wheel weaves as the wheel wills. — The Wheel of Time",
  "It's like the people who believe they'll be happy if they go and live somewhere else. — The Colour of Magic",
  "Words are pale shadows of forgotten names. — The Name of the Wind",
  "It's the questions we can't answer that teach us the most. — The Wise Man's Fear",
  "When you play the game of thrones, you win or you die. — A Game of Thrones",
  "A reader lives a thousand lives before he dies. — A Dance with Dragons",
  "To light a candle is to cast a shadow. — A Wizard of Earthsea",
  "The unread story is not a story. — The Language of the Night",
];

function randomPlaceholder() {
  const i = Math.floor(Math.random() * SCI_FI_QUOTES.length);
  return SCI_FI_QUOTES[i];
}

const composerPlaceholder = ref(randomPlaceholder());

const canSend = computed(() => !!(input.value.trim() || attachments.value.length));

// Mid-run, the same box steers instead of being dead: the prompt is admitted
// into the run that is already going and the agent reads it at its next turn.
// Slash commands are deliberately NOT routed here — a command starts its own
// turn, which is not what steering means.
function steer() {
  if (!canSend.value || !store.isStreaming) return;
  const files = attachments.value.map(({ filename, mime, url }) => ({ filename, mime, url }));
  sendSteer(input.value.trim(), files);
  attachments.value = [];
  input.value = "";
}

function submit() {
  const text = input.value.trim();
  if (!text && !attachments.value.length) return;
  if (store.isStreaming) {
    steer();
    return;
  }

  // "/name args" for a known command runs as a slash command; anything else
  // (including unknown /words) goes out as a normal prompt.
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const known = m && allCommands.value.find((c) => c.name === m[1]);
  if (known && known.source === "builtin") {
    runBuiltinCommand(known.name);
  } else if (known) {
    runCommand(m[1], (m[2] || "").trim());
  } else {
    sendPrompt(
      text,
      attachments.value.map(({ filename, mime, url }) => ({ filename, mime, url }))
    );
  }
  attachments.value = [];
  input.value = "";
}

function onKeydown(e) {
  if (mentionOpen.value) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = mentionMatches.value.length;
      mentionIndex.value =
        e.key === "ArrowDown" ? (mentionIndex.value + 1) % n : (mentionIndex.value - 1 + n) % n;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseMention(mentionMatches.value[mentionIndex.value]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      mentionQuery.value = null;
      return;
    }
  }
  if (slashOpen.value) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = slashMatches.value.length;
      slashIndex.value =
        e.key === "ArrowDown" ? (slashIndex.value + 1) % n : (slashIndex.value - 1 + n) % n;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseSlashCommand(slashMatches.value[slashIndex.value]);
      return;
    }
    if (e.key === "Escape") {
      input.value = "";
      return;
    }
  }
  // Shift+Enter falls through to the browser and inserts a newline. `isComposing`
  // keeps an IME's confirmation Enter from sending a half-typed prompt.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}

// Slash-command autocomplete: server commands + skills (both from opencode.js)
// plus local builtins, matched while the composer holds just "/query".
const BUILTIN_SLASH_COMMANDS = [
  { name: "new", description: "new session in this project" },
];

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

const slashMatches = computed(() => {
  const m = /^\/(\S*)$/.exec(input.value);
  if (!m) return [];
  const query = m[1].toLowerCase();
  return allCommands.value.filter((c) => c.name && c.name.toLowerCase().startsWith(query));
});

const slashOpen = computed(() => slashMatches.value.length > 0);
const slashIndex = ref(0);

watch(slashMatches, () => {
  slashIndex.value = 0;
});

function chooseSlashCommand(cmd) {
  if (!cmd) return;
  if (cmd.source === "builtin") {
    input.value = "";
    runBuiltinCommand(cmd.name);
    return;
  }
  input.value = `/${cmd.name} `;
  nextTick(() => textareaEl.value?.focus());
}

// Builtins run against the harness itself instead of going to the server.
function runBuiltinCommand(name) {
  if (name === "new") {
    startNewChat(activeSessionDirectory() || undefined).catch(() => {});
  }
}

// @-file mention autocomplete: sourced from the same recursive, cached file
// list the Ctrl/Cmd+K palette uses (filesearch.js — PTY-based fdfind/fd/git
// ls-files, since GET /api/fs/list is single-level only). Unlike the slash menu
// (only ever "/query" from an empty box), a mention can start anywhere in the
// message, so it's tracked from the live caret position rather than derived
// straight from `input`.
const mentionQuery = ref(null); // { query, start, end } char offsets into the textarea value, or null
const mentionIndex = ref(0);

function updateMentionState(el) {
  el = el || textareaEl.value;
  if (!el || el.selectionStart == null || el.selectionStart !== el.selectionEnd) {
    mentionQuery.value = null;
    return;
  }
  const before = el.value.slice(0, el.selectionStart);
  // Preceded by start-of-text/whitespace/open-paren so "user@example.com" doesn't trigger.
  const m = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
  if (!m) {
    mentionQuery.value = null;
    return;
  }
  if (!mentionQuery.value) {
    // Just opened: kick a background refresh, same as the palette on open —
    // the cached list (if any) shows immediately via filesFor below.
    const dir = activeSessionDirectory();
    if (dir) refreshFiles(dir);
  }
  mentionQuery.value = { query: m[1], start: el.selectionStart - m[1].length - 1, end: el.selectionStart };
}

const mentionMatches = computed(() => {
  const mq = mentionQuery.value;
  if (!mq) return [];
  const dir = activeSessionDirectory();
  if (!dir) return [];
  const files = filesFor(dir).files;
  const q = mq.query.toLowerCase();
  if (!q) return files.slice(0, 20);
  const scored = [];
  for (const f of files) {
    const score = fuzzyScore(q, f.toLowerCase());
    if (score !== null) scored.push({ f, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((x) => x.f)
    .slice(0, 20);
});

const mentionOpen = computed(() => !!mentionQuery.value && mentionMatches.value.length > 0);

watch(mentionMatches, () => {
  mentionIndex.value = 0;
});

// Replace the "@query" span under the caret with "@path " and land the caret
// right after it, same shape as chooseSlashCommand's refocus.
function chooseMention(path) {
  const mq = mentionQuery.value;
  if (!path || !mq) return;
  const before = input.value.slice(0, mq.start);
  const after = input.value.slice(mq.end);
  const inserted = `@${path} `;
  input.value = before + inserted + after;
  mentionQuery.value = null;
  nextTick(() => {
    const el = textareaEl.value;
    if (!el) return;
    el.focus();
    const cursor = before.length + inserted.length;
    el.setSelectionRange(cursor, cursor);
    autosize();
  });
}

// Combined @input handler: autosize still needs to run on every keystroke,
// and the mention state needs the caret position `e.target` carries (v-model
// updates `input` from the same event, so reading it back off `input` here
// would race the order the two listeners run in).
function onComposerInput(e) {
  autosize();
  updateMentionState(e.target);
}

// Grow the textarea to fit its content (capped by the CSS max-height, past which
// it scrolls). Measuring needs the height released first, hence the "auto" pass.
function autosize() {
  const el = textareaEl.value;
  if (!el) return;
  // An empty textarea measures its placeholder, and the quotes wrap to several
  // lines — drop back to the one-row height from `rows` rather than fitting one.
  if (!el.value) {
    el.style.height = "";
    return;
  }
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Keeps the height in step with the text on the paths that change it without an
// input event — sending (which clears), Escape, picking a slash command.
// `flush: "post"` so the textarea has already been patched when we measure it.
// The template's @input stays as well: v-model holds updates back during IME
// composition, and the box should still grow while a long phrase is composed.
watch(input, autosize, { flush: "post" });

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

function groupByProvider(models) {
  const groups = new Map();
  for (const m of models) {
    const key = m.providerID || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()];
}

// Explicit capability ranking, strongest first — the server's own ordering
// doesn't encode a tier, so the picker sorts on this. Matched as a substring
// of the model label/id (case-insensitive); anything unranked sorts below the
// ranked models, in the order the server gave.
const MODEL_RANK = ["sol", "terra", "luna"];

function modelRank(m) {
  const haystack = `${m.label || ""} ${m.modelID || ""}`.toLowerCase();
  const i = MODEL_RANK.findIndex((name) => haystack.includes(name));
  return i < 0 ? MODEL_RANK.length : i;
}

// Strongest at the top, weakest at the bottom — same bottom-up reading as the
// reasoning menu, since both panels open upward.
function sortByRank(models) {
  return models
    .map((m, i) => ({ m, i, rank: modelRank(m) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.m);
}

const modelGroups = computed(() =>
  groupByProvider(visibleModels.value).map(([provider, models]) => {
    const sorted = sortByRank(models);
    return {
      label: provider,
      options: sorted.map((m, i) => ({
        value: modelKey(m),
        label: m.label,
        // Weakest model gets the "low" reasoning color, strongest gets "max".
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

// Desaturated pastel gradient, cool blue (low effort) to warm red (max effort),
// tuned light enough to read on the dark theme. Variant names not in the map
// get a color from the same gradient by their position in the model's list,
// so any server-provided naming still reads cool-to-warm.
const THINKING_COLORS = {
  off: "hsl(215 38% 72%)",
  minimal: "hsl(190 36% 68%)",
  low: "hsl(160 34% 65%)",
  medium: "hsl(110 32% 64%)",
  high: "hsl(70 38% 64%)",
  xhigh: "hsl(35 42% 66%)",
  max: "hsl(5 46% 70%)",
};

// Named steps of the same scale, used to color the model list: the weakest
// model reads as "low" reasoning, the strongest as "max".
const MODEL_RAMP = ["low", "medium", "high", "xhigh", "max"];

function rampColor(i, n) {
  const t = n > 1 ? i / (n - 1) : 1;
  return THINKING_COLORS[MODEL_RAMP[Math.round(t * (MODEL_RAMP.length - 1))]];
}

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

onMounted(() => {
  autosize();
  window.addEventListener("keydown", onSelectShortcut);
  // A narrower composer re-wraps the text into more lines, so the fitted height
  // has to be recomputed.
  window.addEventListener("resize", autosize);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onSelectShortcut);
  window.removeEventListener("resize", autosize);
});
</script>

<template>
  <footer>
    <ul v-if="mentionOpen" class="slash-menu">
      <li
        v-for="(path, i) in mentionMatches"
        :key="path"
        :class="{ active: i === mentionIndex }"
        @mousedown.prevent="chooseMention(path)"
        @mouseenter="mentionIndex = i"
      >
        <span class="slash-name">@{{ path }}</span>
      </li>
    </ul>
    <ul v-else-if="slashOpen" class="slash-menu">
      <li
        v-for="(cmd, i) in slashMatches"
        :key="`${cmd.source}:${cmd.name}`"
        :class="{ active: i === slashIndex }"
        @mousedown.prevent="chooseSlashCommand(cmd)"
        @mouseenter="slashIndex = i"
      >
        <span class="slash-name">/{{ cmd.name }}</span>
        <span class="slash-desc">{{ cmd.source === "skill" ? `skill · ${cmd.description}` : cmd.description }}</span>
      </li>
    </ul>
    <div class="composer">
      <D20Die />
      <div
        class="composer-field"
        :class="{ dragging }"
        @dragover="onDragOver"
        @dragleave="dragging = false"
        @drop="onDrop"
      >
        <ul v-if="attachments.length" class="attachments">
          <li v-for="att in attachments" :key="att.id" class="attachment" :title="att.filename">
            <img v-if="isImage(att)" :src="att.url" :alt="att.filename" />
            <span v-else class="attachment-name">{{ att.filename }}</span>
            <button
              v-if="isImage(att)"
              type="button"
              class="attachment-edit"
              title="Draw on this image"
              @click="annotatingId = att.id"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path
                  d="M11.5 2.5a1.8 1.8 0 0 1 2.5 2.5L6 13l-3.2.9L3.7 10l7.8-7.5Z"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              class="attachment-remove"
              title="Remove attachment"
              @click="removeAttachment(att.id)"
            >
              ×
            </button>
          </li>
        </ul>
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="1"
          :placeholder="composerPlaceholder"
          :title="
            store.isStreaming
              ? 'Enter to steer — the agent reads it at its next turn. Shift+Enter for newline'
              : 'Enter to send, Shift+Enter for newline'
          "
          @keydown="onKeydown"
          @input="onComposerInput"
          @keyup="updateMentionState()"
          @click="updateMentionState()"
          @paste="onPaste"
        ></textarea>

        <div class="composer-actions">
          <input
            ref="fileInputEl"
            type="file"
            multiple
            class="visually-hidden"
            @change="onPickFiles"
          />
          <button
            type="button"
            class="composer-icon-btn attach"
            title="Attach files (or paste / drop them here)"
            @click="fileInputEl?.click()"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path
                d="M10.5 5 5.9 9.6a1.6 1.6 0 0 0 2.3 2.3l4.9-4.9a3 3 0 0 0-4.2-4.2L3.6 8a4.4 4.4 0 0 0 6.2 6.2l4.1-4.1"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <SteerButton v-if="store.isStreaming" :disabled="!canSend" @steer="steer" />
          <button
            v-if="store.isStreaming"
            class="composer-icon-btn stop"
            title="Stop"
            @click="abortSession"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
          <button
            v-else
            class="composer-icon-btn send"
            :disabled="(!input.trim() && !attachments.length) || !store.activeSessionId"
            title="Send prompt"
            @click="submit"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M14.7 1.3 7.3 8.7M14.7 1.3 10 14.7 7.3 8.7 1.3 6 14.7 1.3Z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="controls">
      <SelectMenu
        v-if="store.availableAgents.length"
        class="agent-select"
        :groups="agentGroups"
        :model-value="store.selectedAgent"
        title="Agent"
        @update:model-value="setAgent"
      />

      <SelectMenu
        v-if="store.availableModels.length"
        class="model-select"
        :groups="modelGroups"
        :model-value="selectedModelKey"
        title="Model (Ctrl/Cmd+←/→)"
        :color="selectedModelColor"
        :max-width="220"
        @update:model-value="onModelChange"
      />

      <SelectMenu
        v-if="thinkingLevels.length"
        class="thinking-select"
        :groups="thinkingGroups"
        :model-value="store.thinkingLevel || ''"
        title="Reasoning effort (Ctrl/Cmd+↑/↓)"
        :color="thinkingColor(store.thinkingLevel)"
        @update:model-value="setThinkingLevel"
      />
    </div>

    <ImageAnnotator
      v-if="annotating"
      :src="annotating.url"
      :filename="annotating.filename"
      @save="onAnnotated"
      @cancel="annotatingId = ''"
    />
  </footer>
</template>
