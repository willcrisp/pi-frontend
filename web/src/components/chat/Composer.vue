<!--
  The composer: the prompt box and everything attached to it.
  Send/steer/abort and the two autocomplete menus are wired here; the pieces
  themselves live in ../../composables/ —
    useAttachments   paste / drop / picker, thumbnails, image markup
    useAutosize      textarea height tracking its content
    useSlashCommands "/query" menu over server commands, skills and builtins
    useFileMentions  "@path" menu over the cached project file list
    useModelPicker   agent / model / reasoning selects and their shortcuts

  Enter sends, or steers when a run is already going — see submit(). Shift+Enter
  inserts a newline. The three selects are themed SelectMenu popovers that open
  upward, so their lists read bottom-up.
-->
<script setup>
import { computed, ref } from "vue";
import {
  opencodeStore as store,
  sendPrompt,
  sendSteer,
  abortSession,
  setAgent,
  setThinkingLevel,
  runCommand,
} from "../../stores/opencode.js";
import { randomPlaceholder } from "../../lib/placeholders.js";
import { useAttachments } from "../../composables/useAttachments.js";
import { useAutosize } from "../../composables/useAutosize.js";
import { useFileMentions } from "../../composables/useFileMentions.js";
import { useSlashCommands } from "../../composables/useSlashCommands.js";
import { useModelPicker } from "../../composables/useModelPicker.js";
import { listMenuKeydown } from "../../composables/useListMenu.js";
import D20Die from "./D20Die.vue";
import SelectMenu from "./SelectMenu.vue";
import SteerButton from "./SteerButton.vue";
import ImageAnnotator from "../dialogs/ImageAnnotator.vue";

const input = ref("");
const textareaEl = ref(null);
const fileInputEl = ref(null);

// Destructured to top-level bindings so the template auto-unwraps the refs —
// `attachments`, not `files.attachments.value`.
const {
  attachments,
  dragging,
  annotating,
  annotatingId,
  removeAttachment,
  onPaste,
  onDrop,
  onDragOver,
  onPickFiles,
  isImage,
  onAnnotated,
  toPromptFiles,
  clear: clearAttachments,
} = useAttachments();

const autosize = useAutosize(textareaEl, input);

// Each menu is kept whole for onKeydown (which drives them uniformly) and also
// destructured for the template.
const { menu: mentionMenu, updateMentionState } = useFileMentions(input, textareaEl, autosize);
const {
  open: mentionOpen,
  matches: mentionMatches,
  index: mentionIndex,
  choose: chooseMention,
} = mentionMenu;

const { menu: slashMenu, allCommands, runBuiltinCommand } = useSlashCommands(input, textareaEl);
const {
  open: slashOpen,
  matches: slashMatches,
  index: slashIndex,
  choose: chooseSlashCommand,
} = slashMenu;

const {
  agentGroups,
  modelGroups,
  selectedModelKey,
  selectedModelColor,
  onModelChange,
  thinkingLevels,
  thinkingGroups,
  thinkingColor,
} = useModelPicker();

const composerPlaceholder = ref(randomPlaceholder());
const canSend = computed(() => !!(input.value.trim() || attachments.value.length));

// Mid-run, the same box steers instead of being dead: the prompt is admitted
// into the run that is already going and the agent reads it at its next turn.
// Slash commands are deliberately NOT routed here — a command starts its own
// turn, which is not what steering means.
function steer() {
  if (!canSend.value || !store.isStreaming) return;
  sendSteer(input.value.trim(), toPromptFiles());
  clearAttachments();
  input.value = "";
}

function submit() {
  const text = input.value.trim();
  if (!canSend.value) return;
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
    sendPrompt(text, toPromptFiles());
  }
  clearAttachments();
  input.value = "";
}

function onKeydown(e) {
  // An open menu owns the arrow/Enter/Tab/Escape keys. Mentions take precedence
  // over slash commands, matching the template's v-if/v-else-if order — only one
  // menu is ever on screen.
  for (const menu of [mentionMenu, slashMenu]) {
    if (listMenuKeydown(e, menu)) return;
  }
  // Shift+Enter falls through to the browser and inserts a newline. `isComposing`
  // keeps an IME's confirmation Enter from sending a half-typed prompt.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}

// Combined @input handler: autosize still needs to run on every keystroke, and
// the mention state needs the caret position `e.target` carries (v-model updates
// `input` from the same event, so reading it back off `input` here would race
// the order the two listeners run in).
function onComposerInput(e) {
  autosize();
  updateMentionState(e.target);
}
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
            :disabled="!canSend || !store.activeSessionId"
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
