<!--
  Manage the sub-agents the `subagent` tool can dispatch: create, edit and
  delete the markdown definition files behind them (subagents.js), setting the
  model and reasoning effort each one runs with.

  Sub-agents only. Primary agents are chosen per session from the composer's
  agent picker, and editing them here — where a bad edit lands on every future
  session — has no upside, so they are not listed.

  List view groups project-scope and global-scope definitions and shows the
  built-ins that have no file yet; the editor is a structured form, falling
  back to raw text for a file this codec can't safely rewrite.
-->
<script setup>
import { computed, onMounted, ref } from "vue";
import { opencodeStore } from "../../stores/opencode.js";
import { activeSessionDirectory } from "../../stores/projects.js";
import { confirmDialog } from "../../stores/confirm.js";
import {
  builtInSubagents,
  defStatus,
  deleteSubagent,
  loadSubagents,
  modelString,
  saveSubagent,
  saveTargetPath,
  subagentsStore,
} from "../../stores/subagents.js";
import { useDialogEscape } from "../../composables/useDialogEscape.js";

const emit = defineEmits(["close"]);

const NAME_RE = /^[A-Za-z0-9._-]+$/;

const editing = ref(null);
const toolInput = ref("");

onMounted(loadSubagents);

const projectDirectory = computed(() => activeSessionDirectory());

const projectDefs = computed(() => subagentsStore.defs.filter((d) => d.scope === "project"));
const globalDefs = computed(() => subagentsStore.defs.filter((d) => d.scope === "global"));
const builtIns = computed(() => builtInSubagents());

// Catalog models as `providerID/modelID`, grouped by provider. A model the file
// names but the catalog doesn't have (a provider since disconnected, say) is
// added as its own option so opening the editor can't silently drop it.
const modelsByProvider = computed(() => {
  const groups = new Map();
  for (const m of opencodeStore.availableModels) {
    if (!groups.has(m.providerID)) groups.set(m.providerID, []);
    groups.get(m.providerID).push({ value: `${m.providerID}/${m.modelID}`, label: m.label || m.modelID });
  }
  const current = editing.value && editing.value.model;
  if (current && ![...groups.values()].some((opts) => opts.some((o) => o.value === current))) {
    groups.set("not in catalog", [{ value: current, label: current }]);
  }
  return [...groups.entries()];
});

// Reasoning-effort presets the selected model actually offers.
const variantOptions = computed(() => {
  const model = editing.value && editing.value.model;
  const slash = model ? model.indexOf("/") : -1;
  if (slash < 0) return [];
  const providerID = model.slice(0, slash);
  const modelID = model.slice(slash + 1);
  const info = opencodeStore.availableModels.find(
    (m) => m.providerID === providerID && m.modelID === modelID
  );
  const variants = (info && info.variants) || [];
  const current = editing.value.variant;
  return current && !variants.includes(current) ? [...variants, current] : variants;
});

const deniedTools = computed(() => {
  const tools = (editing.value && editing.value.tools) || {};
  return Object.keys(tools).filter((name) => tools[name] === false);
});

const nameError = computed(() => {
  const e = editing.value;
  if (!e || e.isRaw) return "";
  const id = (e.id || "").trim();
  if (!id) return "name is required";
  if (!NAME_RE.test(id)) return "only letters, numbers, dot, underscore and dash allowed";
  return "";
});

const canSave = computed(() => {
  if (subagentsStore.saving || !editing.value) return false;
  if (editing.value.isRaw) return true;
  if (nameError.value) return false;
  return !(editing.value.scope === "project" && !projectDirectory.value);
});

const targetPath = computed(() => {
  const e = editing.value;
  if (!e) return "";
  return saveTargetPath({ ...e, id: (e.id || "…").trim() }, projectDirectory.value);
});

const editorTitle = computed(() => {
  const e = editing.value;
  if (!e) return "Sub-agents";
  if (e.isRaw) return e.path;
  if (e.isNew) return e.fromBuiltIn ? `Override ${e.id}` : "New sub-agent";
  return e.id;
});

function statusChip(def) {
  return defStatus(def) === "active" ? "active" : "restart to apply";
}

function modelLabel(def) {
  if (!def.model) return "";
  return def.variant ? `${def.model} · ${def.variant}` : def.model;
}

function newSubagent() {
  subagentsStore.error = "";
  editing.value = {
    isNew: true,
    isRaw: false,
    scope: projectDirectory.value ? "project" : "global",
    id: "",
    description: "",
    model: "",
    variant: "",
    temperature: "",
    tools: {},
    prompt: "",
    entries: [],
  };
}

function openDef(def) {
  subagentsStore.error = "";
  if (def.parseError) {
    editing.value = {
      isNew: false,
      isRaw: true,
      scope: def.scope,
      originalScope: def.scope,
      id: def.id,
      path: def.path,
      originalPath: def.path,
      raw: def.raw,
      parseError: def.parseError,
    };
    return;
  }
  editing.value = {
    isNew: false,
    isRaw: false,
    scope: def.scope,
    originalScope: def.scope,
    id: def.id,
    originalPath: def.path,
    description: def.description || "",
    model: def.model || "",
    variant: def.variant || "",
    temperature: def.temperature || "",
    tools: { ...(def.tools || {}) },
    prompt: def.prompt || "",
    entries: def.entries || [],
  };
}

// A built-in has no file; editing one writes a same-named definition that
// overrides its fields. Its live system prompt is carried over so saving an
// override that only changes the model doesn't blank the prompt.
function openBuiltIn(agent) {
  subagentsStore.error = "";
  editing.value = {
    isNew: true,
    isRaw: false,
    fromBuiltIn: true,
    scope: projectDirectory.value ? "project" : "global",
    id: agent.id || agent.name,
    description: agent.description || "",
    model: modelString(agent.model),
    variant: (agent.model && agent.model.variant) || "",
    temperature:
      agent.request && agent.request.body && agent.request.body.temperature != null
        ? String(agent.request.body.temperature)
        : "",
    tools: {},
    prompt: agent.system || "",
    entries: [],
  };
}

function backToList() {
  editing.value = null;
  subagentsStore.error = "";
}

function addToolChips(raw) {
  const names = raw.split(",").map((t) => t.trim()).filter(Boolean);
  for (const name of names) editing.value.tools[name] = false;
}

function onToolInputKeydown(e) {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addToolChips(toolInput.value);
    toolInput.value = "";
  } else if (e.key === "Backspace" && !toolInput.value && deniedTools.value.length) {
    removeToolChip(deniedTools.value[deniedTools.value.length - 1]);
  }
}

function onToolInputBlur() {
  if (toolInput.value.trim()) {
    addToolChips(toolInput.value);
    toolInput.value = "";
  }
}

function removeToolChip(name) {
  delete editing.value.tools[name];
}

// Reasoning effort is a property of a specific model's variant list, so a model
// change can strand the old value.
function onModelChange() {
  const e = editing.value;
  if (!e.model) {
    e.variant = "";
    return;
  }
  if (e.variant && !variantOptions.value.includes(e.variant)) e.variant = "";
}

async function onSave() {
  const e = editing.value;
  if (!e || !canSave.value) return;
  const draft = e.isRaw
    ? { scope: e.scope, originalScope: e.originalScope, id: e.id, raw: e.raw, originalPath: e.originalPath }
    : { ...e, id: e.id.trim() };
  if (await saveSubagent(draft)) editing.value = null;
}

async function onDelete() {
  const e = editing.value;
  if (!e || !e.originalPath) return;
  const ok = await confirmDialog({
    title: `Delete sub-agent "${e.id}"`,
    message: `${e.originalPath} will be removed from the opencode server. This cannot be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  if (await deleteSubagent({ path: e.originalPath })) editing.value = null;
}

const { onBackdrop } = useDialogEscape(() => emit("close"));
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span class="agents-head-title">
          <button
            v-if="editing"
            type="button"
            class="agents-back"
            title="Back to list"
            @click="backToList"
          >
            ←
          </button>
          {{ editorTitle }}
        </span>
        <button class="connect-close" title="Close" @click="$emit('close')">✕</button>
      </div>

      <p v-if="subagentsStore.error" class="connect-error">{{ subagentsStore.error }}</p>
      <p v-if="subagentsStore.notice" class="connect-hint">
        {{ subagentsStore.notice }}
        <button
          type="button"
          class="agents-back"
          title="Dismiss"
          @click="subagentsStore.notice = ''"
        >
          ✕
        </button>
      </p>

      <!-- List view -->
      <template v-if="!editing">
        <div v-if="subagentsStore.loading" class="connect-hint">Reading agent files…</div>
        <template v-else>
          <div class="agents-section">
            <div class="agents-section-head">
              <span>Project</span>
              <button type="button" class="agents-add" @click="newSubagent">+ new sub-agent</button>
            </div>
            <p class="agents-hint agents-mono">
              {{ projectDirectory ? `${projectDirectory}/.opencode/agent` : "no session open — new sub-agents go to the global scope" }}
            </p>
            <ul class="agents-list">
              <li v-for="d in projectDefs" :key="d.path" class="agents-row" @click="openDef(d)">
                <div class="agents-row-main">
                  <span class="agents-name">{{ d.id }}</span>
                  <span class="agents-desc">{{ d.description }}</span>
                </div>
                <div class="agents-row-meta">
                  <span v-if="modelLabel(d)" class="agents-chip">{{ modelLabel(d) }}</span>
                  <span v-if="d.parseError" class="agents-warn" :title="d.parseError">⚠ parse error</span>
                  <span v-else class="agents-chip">{{ statusChip(d) }}</span>
                </div>
              </li>
              <li v-if="!projectDefs.length" class="agents-row agents-empty">none</li>
            </ul>
          </div>

          <div class="agents-section">
            <div class="agents-section-head">
              <span>Global</span>
            </div>
            <p class="agents-hint agents-mono">~/.config/opencode/agent</p>
            <ul class="agents-list">
              <li v-for="d in globalDefs" :key="d.path" class="agents-row" @click="openDef(d)">
                <div class="agents-row-main">
                  <span class="agents-name">{{ d.id }}</span>
                  <span class="agents-desc">{{ d.description }}</span>
                </div>
                <div class="agents-row-meta">
                  <span v-if="modelLabel(d)" class="agents-chip">{{ modelLabel(d) }}</span>
                  <span v-if="d.parseError" class="agents-warn" :title="d.parseError">⚠ parse error</span>
                  <span v-else class="agents-chip">{{ statusChip(d) }}</span>
                </div>
              </li>
              <li v-if="!globalDefs.length" class="agents-row agents-empty">none</li>
            </ul>
          </div>

          <div v-if="builtIns.length" class="agents-section">
            <div class="agents-section-head">
              <span>Built-in</span>
            </div>
            <ul class="agents-list">
              <li v-for="a in builtIns" :key="a.id || a.name" class="agents-row" @click="openBuiltIn(a)">
                <div class="agents-row-main">
                  <span class="agents-name">{{ a.id || a.name }}</span>
                  <span class="agents-desc">{{ a.description }}</span>
                </div>
                <div class="agents-row-meta">
                  <span v-if="modelString(a.model)" class="agents-chip">{{ modelString(a.model) }}</span>
                  <span v-if="a.hidden" class="agents-chip">hidden</span>
                  <span class="agents-chip">override…</span>
                </div>
              </li>
            </ul>
            <p class="agents-hint">
              Built-ins ship with the server and have no file. Opening one writes a
              same-named definition that overrides its fields.
            </p>
          </div>
        </template>
      </template>

      <!-- Raw editor: the file's frontmatter is outside what the structured
           form can rewrite safely, so it's edited as text. -->
      <div v-else-if="editing.isRaw" class="agents-form">
        <p class="agents-hint">
          This file couldn't be parsed as a simple agent definition, so it's shown as raw
          text. Fix the frontmatter and save, or delete it.
        </p>
        <p v-if="editing.parseError" class="connect-error">{{ editing.parseError }}</p>
        <textarea
          v-model="editing.raw"
          class="agents-textarea agents-mono agents-raw"
          spellcheck="false"
        ></textarea>
        <div class="agents-actions">
          <button type="button" :disabled="subagentsStore.saving" @click="onSave">
            {{ subagentsStore.saving ? "Saving…" : "Save" }}
          </button>
          <button
            type="button"
            class="agents-danger"
            :disabled="subagentsStore.saving"
            @click="onDelete"
          >
            Delete
          </button>
          <button type="button" class="connect-secondary" @click="backToList">Cancel</button>
        </div>
      </div>

      <!-- Structured editor -->
      <form v-else class="agents-form" @submit.prevent="onSave">
        <div class="agents-field-row">
          <label class="agents-field">
            <span class="agents-field-label">name</span>
            <input v-model="editing.id" type="text" autocomplete="off" spellcheck="false" />
          </label>
          <label class="agents-field">
            <span class="agents-field-label">scope</span>
            <select v-model="editing.scope">
              <option value="project" :disabled="!projectDirectory">project</option>
              <option value="global">global</option>
            </select>
          </label>
        </div>
        <p v-if="nameError" class="agents-field-error">{{ nameError }}</p>
        <p v-if="targetPath" class="agents-hint">{{ targetPath }}</p>
        <p v-if="editing.fromBuiltIn" class="agents-hint">
          Overrides the built-in <strong>{{ editing.id }}</strong> — keep the name to
          override it, change it to define a separate sub-agent.
        </p>

        <label class="agents-field">
          <span class="agents-field-label">description</span>
          <textarea v-model="editing.description" class="agents-textarea" rows="2"></textarea>
          <span class="agents-hint">
            How the dispatching agent decides to pick this sub-agent. Worth being specific.
          </span>
        </label>

        <label class="agents-field">
          <span class="agents-field-label">model</span>
          <select v-model="editing.model" @change="onModelChange">
            <option value="">inherit (session model)</option>
            <optgroup v-for="[provider, opts] in modelsByProvider" :key="provider" :label="provider">
              <option v-for="o in opts" :key="o.value" :value="o.value">{{ o.label }}</option>
            </optgroup>
          </select>
        </label>

        <div class="agents-field-row">
          <label class="agents-field">
            <span class="agents-field-label">reasoning</span>
            <select v-model="editing.variant" :disabled="!editing.model || !variantOptions.length">
              <option value="">model default</option>
              <option v-for="v in variantOptions" :key="v" :value="v">{{ v }}</option>
            </select>
            <span v-if="!editing.model" class="agents-hint">pick a model first</span>
            <span v-else-if="!variantOptions.length" class="agents-hint">
              this model has no reasoning presets
            </span>
          </label>

          <label class="agents-field">
            <span class="agents-field-label">temperature</span>
            <input
              v-model="editing.temperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
              placeholder="default"
            />
          </label>
        </div>

        <label class="agents-field">
          <span class="agents-field-label">denied tools</span>
          <div class="agents-tools-input">
            <span v-for="tool in deniedTools" :key="tool" class="agents-tool-chip">
              {{ tool }}
              <button type="button" aria-label="Remove tool" @click="removeToolChip(tool)">×</button>
            </span>
            <input
              v-model="toolInput"
              type="text"
              :placeholder="deniedTools.length ? '' : 'empty = every tool allowed'"
              autocomplete="off"
              spellcheck="false"
              @keydown="onToolInputKeydown"
              @blur="onToolInputBlur"
            />
          </div>
        </label>

        <label class="agents-field">
          <span class="agents-field-label">system prompt</span>
          <textarea
            v-model="editing.prompt"
            class="agents-textarea agents-mono agents-raw"
            spellcheck="false"
          ></textarea>
        </label>

        <div class="agents-actions">
          <button type="submit" :disabled="!canSave">
            {{ subagentsStore.saving ? "Saving…" : "Save" }}
          </button>
          <button
            v-if="editing.originalPath"
            type="button"
            class="agents-danger"
            :disabled="subagentsStore.saving"
            @click="onDelete"
          >
            Delete
          </button>
          <button type="button" class="connect-secondary" @click="backToList">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</template>
