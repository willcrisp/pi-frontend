<script setup>
import { computed, onMounted, ref } from "vue";
import { THINKING_LEVELS, store } from "../../stores/pi.js";
import { projectsStore } from "../../stores/projects.js";
import {
  agentsStore,
  closeAgents,
  deleteAgent,
  fetchAgents,
  joinModelThinking,
  saveAgent,
  splitModelThinking,
} from "../../stores/agents.js";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

onMounted(fetchAgents);

const userAgents = computed(() => agentsStore.agents.filter((a) => a.scope === "user"));
const projectAgents = computed(() => agentsStore.agents.filter((a) => a.scope === "project"));

const modelsByProvider = computed(() => {
  const groups = new Map();
  for (const m of store.availableModels) {
    const provider = m.provider || "";
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push({ value: `${m.provider}/${m.id}`, label: m.name || m.id });
  }
  const base = agentsStore.editing && !agentsStore.editing.isRaw ? agentsStore.editing.modelBase : "";
  if (base && ![...groups.values()].some((opts) => opts.some((o) => o.value === base))) {
    groups.set("", [{ value: base, label: base }, ...(groups.get("") || [])]);
  }
  return [...groups.entries()];
});

const toolInput = ref("");

const toolChips = computed(() => {
  const raw = agentsStore.editing?.tools || "";
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
});

function addToolChips(raw) {
  const names = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (!names.length) return;
  const existing = toolChips.value;
  const merged = [...existing, ...names.filter((n) => !existing.includes(n))];
  agentsStore.editing.tools = merged.join(",");
}

function onToolInputKeydown(e) {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addToolChips(toolInput.value);
    toolInput.value = "";
  } else if (e.key === "Backspace" && !toolInput.value && toolChips.value.length) {
    removeToolChip(toolChips.value.length - 1);
  }
}

function onToolInputBlur() {
  if (toolInput.value.trim()) {
    addToolChips(toolInput.value);
    toolInput.value = "";
  }
}

function removeToolChip(index) {
  const chips = [...toolChips.value];
  chips.splice(index, 1);
  agentsStore.editing.tools = chips.join(",");
}

const nameError = computed(() => {
  const e = agentsStore.editing;
  if (!e || e.isRaw) return "";
  const name = (e.name || "").trim();
  if (!name) return "name is required";
  if (!NAME_RE.test(name)) return "only letters, numbers, dot, underscore and dash allowed";
  return "";
});

const canSave = computed(() => {
  if (agentsStore.saving) return false;
  const e = agentsStore.editing;
  if (!e) return false;
  if (e.isRaw) return true;
  return !nameError.value;
});

const editorTitle = computed(() => {
  const e = agentsStore.editing;
  if (!e) return "Manage sub-agents";
  if (e.isRaw) return e.fileName;
  if (e.isNew) return `New ${e.scope} agent`;
  return e.name || e.originalFileName;
});

function onBackdrop(e) {
  if (e.target === e.currentTarget) closeAgents();
}

function backToList() {
  agentsStore.editing = null;
  agentsStore.error = "";
}

function newAgent(scope) {
  agentsStore.error = "";
  agentsStore.editing = {
    isRaw: false,
    isNew: true,
    scope,
    name: "",
    description: "",
    tools: "",
    modelBase: "",
    modelLevel: "",
    systemPrompt: "",
  };
}

function openEditor(agent) {
  agentsStore.error = "";
  if (agent.parseError) {
    agentsStore.editing = {
      isRaw: true,
      isNew: false,
      scope: agent.scope,
      fileName: agent.fileName,
      raw: agent.raw,
      parseError: agent.parseError,
    };
    return;
  }
  const { base, level } = splitModelThinking(agent.model || "");
  agentsStore.editing = {
    isRaw: false,
    isNew: false,
    scope: agent.scope,
    originalFileName: agent.fileName,
    name: agent.name || "",
    description: agent.description || "",
    tools: agent.tools || "",
    modelBase: base,
    modelLevel: level,
    systemPrompt: agent.systemPrompt || "",
  };
}

async function onSave() {
  const e = agentsStore.editing;
  if (!e || !canSave.value) return;
  let payload;
  if (e.isRaw) {
    payload = { scope: e.scope, fileName: e.fileName, raw: e.raw };
  } else {
    payload = {
      scope: e.scope,
      name: e.name.trim(),
      description: e.description.trim(),
      tools: e.tools.trim() || undefined,
      model: joinModelThinking(e.modelBase, e.modelLevel) || undefined,
      systemPrompt: e.systemPrompt,
    };
    if (e.originalFileName) payload.originalFileName = e.originalFileName;
  }
  if (e.scope === "project" && projectsStore.currentProjectId) {
    payload.projectId = projectsStore.currentProjectId;
  }
  const ok = await saveAgent(payload);
  if (ok) agentsStore.editing = null;
}

async function onDelete() {
  const e = agentsStore.editing;
  if (!e) return;
  const label = e.isRaw ? e.fileName : e.originalFileName;
  if (!confirm(`Delete agent "${label}"? This cannot be undone.`)) return;
  const fileName = e.isRaw ? e.fileName : e.originalFileName;
  const ok = await deleteAgent({ scope: e.scope, fileName });
  if (ok) agentsStore.editing = null;
}
</script>

<template>
  <div class="connect-backdrop" @mousedown="onBackdrop">
    <div class="connect-panel agents-panel">
      <div class="connect-head">
        <span class="agents-head-title">
          <button v-if="agentsStore.editing" type="button" class="agents-back" title="Back to list" @click="backToList">←</button>
          {{ editorTitle }}
        </span>
        <button class="connect-close" title="Close" @click="closeAgents">✕</button>
      </div>

      <p v-if="agentsStore.error" class="connect-error">{{ agentsStore.error }}</p>

      <!-- List view -->
      <template v-if="!agentsStore.editing">
        <div v-if="agentsStore.loading" class="connect-hint">Loading agents…</div>
        <template v-else>
          <div class="agents-section">
            <div class="agents-section-head">
              <span>User agents</span>
              <button type="button" class="agents-add" @click="newAgent('user')">+ new agent</button>
            </div>
            <ul class="agents-list">
              <li v-for="a in userAgents" :key="a.fileName" class="agents-row" @click="openEditor(a)">
                <div class="agents-row-main">
                  <span class="agents-name">{{ a.name || a.fileName }}</span>
                  <span class="agents-desc">{{ a.description }}</span>
                </div>
                <div class="agents-row-meta">
                  <span v-if="a.model" class="agents-chip">{{ a.model }}</span>
                  <span v-if="a.parseError" class="agents-warn" :title="a.parseError">⚠ parse error</span>
                </div>
              </li>
              <li v-if="!userAgents.length" class="agents-row agents-empty">none</li>
            </ul>
          </div>

          <div v-if="projectsStore.currentProjectId" class="agents-section">
            <div class="agents-section-head">
              <span>Project agents</span>
              <button type="button" class="agents-add" @click="newAgent('project')">+ new agent</button>
            </div>
            <ul class="agents-list">
              <li v-for="a in projectAgents" :key="a.fileName" class="agents-row" @click="openEditor(a)">
                <div class="agents-row-main">
                  <span class="agents-name">{{ a.name || a.fileName }}</span>
                  <span class="agents-desc">{{ a.description }}</span>
                </div>
                <div class="agents-row-meta">
                  <span v-if="a.model" class="agents-chip">{{ a.model }}</span>
                  <span v-if="a.parseError" class="agents-warn" :title="a.parseError">⚠ parse error</span>
                </div>
              </li>
              <li v-if="!projectAgents.length" class="agents-row agents-empty">none</li>
            </ul>
          </div>
        </template>
      </template>

      <!-- Raw editor (parse error) -->
      <div v-else-if="agentsStore.editing.isRaw" class="agents-form">
        <p class="agents-hint">
          This file couldn't be parsed as a valid agent definition, so it's shown as raw text.
          Fix the frontmatter and save, or delete it.
        </p>
        <p v-if="agentsStore.editing.parseError" class="connect-error">{{ agentsStore.editing.parseError }}</p>
        <textarea v-model="agentsStore.editing.raw" class="agents-textarea agents-mono agents-raw" spellcheck="false"></textarea>
        <div class="agents-actions">
          <button type="button" :disabled="agentsStore.saving" @click="onSave">
            {{ agentsStore.saving ? "Saving…" : "Save" }}
          </button>
          <button type="button" class="agents-danger" :disabled="agentsStore.saving" @click="onDelete">Delete</button>
          <button type="button" class="connect-secondary" @click="backToList">Cancel</button>
        </div>
      </div>

      <!-- Structured editor -->
      <form v-else class="agents-form" @submit.prevent="onSave">
        <label class="agents-field">
          <span class="agents-field-label">name</span>
          <input v-model="agentsStore.editing.name" type="text" autocomplete="off" spellcheck="false" />
        </label>
        <p v-if="nameError" class="agents-field-error">{{ nameError }}</p>

        <label class="agents-field">
          <span class="agents-field-label">description</span>
          <textarea v-model="agentsStore.editing.description" class="agents-textarea" rows="2"></textarea>
        </label>

        <label class="agents-field">
          <span class="agents-field-label">tools</span>
          <div class="agents-tools-input">
            <span v-for="(tool, i) in toolChips" :key="tool" class="agents-tool-chip">
              {{ tool }}
              <button type="button" @click="removeToolChip(i)" aria-label="Remove tool">×</button>
            </span>
            <input
              v-model="toolInput"
              type="text"
              :placeholder="toolChips.length ? '' : 'empty = all tools'"
              autocomplete="off"
              spellcheck="false"
              @keydown="onToolInputKeydown"
              @blur="onToolInputBlur"
            />
          </div>
        </label>

        <div class="agents-field-row">
          <label class="agents-field">
            <span class="agents-field-label">model</span>
            <select v-model="agentsStore.editing.modelBase">
              <option value="">inherit (session default)</option>
              <optgroup
                v-for="[provider, opts] in modelsByProvider"
                :key="provider"
                :label="provider"
              >
                <option v-for="o in opts" :key="o.value" :value="o.value">{{ o.label }}</option>
              </optgroup>
            </select>
          </label>

          <label class="agents-field">
            <span class="agents-field-label">reasoning</span>
            <select v-model="agentsStore.editing.modelLevel" :disabled="!agentsStore.editing.modelBase">
              <option value="">default</option>
              <option v-for="lvl in THINKING_LEVELS" :key="lvl" :value="lvl">{{ lvl }}</option>
            </select>
            <span v-if="!agentsStore.editing.modelBase" class="agents-hint">reasoning requires an explicit model</span>
          </label>
        </div>

        <label class="agents-field">
          <span class="agents-field-label">system prompt</span>
          <textarea v-model="agentsStore.editing.systemPrompt" class="agents-textarea agents-mono agents-raw" spellcheck="false"></textarea>
        </label>

        <div class="agents-actions">
          <button type="submit" :disabled="!canSave">{{ agentsStore.saving ? "Saving…" : "Save" }}</button>
          <button
            v-if="!agentsStore.editing.isNew"
            type="button"
            class="agents-danger"
            :disabled="agentsStore.saving"
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
