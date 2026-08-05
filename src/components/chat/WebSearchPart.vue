<!--
  A `websearch` tool call, rendered as the search it is rather than as a
  collapsed tool row.

  Two things a generic tool row got wrong here. A search is slow — seconds of
  provider round-trips — and collapsed behind a summary there was nothing on
  screen saying what was being looked for or that anything was happening; the
  provider's own progress messages ("Checking official documentation") arrive on
  `session.tool.progress` and were thrown away. And its result is a list of
  pages: as a `<pre>` of JSON they were text you had to read and retype, not
  links you could follow.

  So the query stays visible for the whole call, progress renders as it arrives,
  and each source is a link. Pages found mid-search show immediately — the
  progress event carries them, so the first results are readable before the call
  settles.

  Sources come from the result content blocks: a `json` block whose value is an
  array of {title, url, snippet} is the shape the tool returns. A provider that
  answers in prose instead falls back to scraping links out of the text, so an
  unrecognised result shape still renders as something followable.

  An aborted provider response (an interrupted step) comes back as a *successful*
  tool call whose content is `{"type":"aborted","message":…}` — surfaced here as
  a failure, because a search that returned nothing and a search that was cut off
  are not the same thing to look at.
-->
<script setup>
import { computed } from "vue";

const props = defineProps({
  part: { type: Object, required: true },
});

const state = computed(() => props.part.state || {});

const status = computed(() => state.value.status || "pending");

const query = computed(() => {
  const input = props.part.input;
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return input.query || input.q || input.search || "";
});

function contentBlocks() {
  const content = state.value.content;
  if (Array.isArray(content)) return content;
  return content ? [content] : [];
}

function blockText(block) {
  if (typeof block === "string") return block;
  return block && typeof block.text === "string" ? block.text : "";
}

// The provider's own progress line. `session.tool.progress` carries it as
// `{message}` on some builds and as a bare string on others.
const progress = computed(() => {
  const p = state.value.progress;
  if (!p) return "";
  if (typeof p === "string") return p;
  return p.message || p.text || "";
});

// An aborted search reports success and puts the abort in its content, so it
// has to be read back out of there.
const aborted = computed(() => {
  for (const block of contentBlocks()) {
    const text = blockText(block).trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.type === "aborted") {
        return parsed.message || "Search was interrupted";
      }
    } catch {
      // not a JSON payload — ordinary result text
    }
  }
  return "";
});

const failed = computed(() => status.value === "error" || !!aborted.value);

const errorText = computed(() => aborted.value || state.value.error || "");

const statusLabel = computed(() => {
  if (aborted.value) return "Interrupted";
  if (status.value === "error") return "Failed";
  if (status.value === "running" || status.value === "pending") return "Searching…";
  return "";
});

// --- Sources -----------------------------------------------------------------

// Only schemes a browser will follow. Result content comes from a third-party
// search provider, so anything else (javascript: being the one that matters) is
// dropped rather than rendered as a link.
const SAFE_URL = /^https?:\/\//i;

function pushSource(list, seen, source) {
  const url = typeof source?.url === "string" ? source.url.replace(/[.,;:]+$/, "") : "";
  if (!url || !SAFE_URL.test(url) || seen.has(url)) return;
  seen.add(url);
  list.push({
    url,
    title: typeof source.title === "string" ? source.title : "",
    snippet: typeof source.snippet === "string" ? source.snippet : "",
  });
}

// Links scraped out of prose, for a provider that doesn't return structured
// results. Markdown links first so their text becomes the title.
function scrapeSources(text, list, seen) {
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = markdown.exec(text))) {
    pushSource(list, seen, { title: match[1], url: match[2] });
  }
  for (const raw of text.match(/https?:\/\/[^\s<>'"`)\]]+/g) || []) {
    pushSource(list, seen, { url: raw });
  }
}

const sources = computed(() => {
  if (aborted.value) return [];
  const list = [];
  const seen = new Set();
  for (const block of contentBlocks()) {
    if (block && block.type === "json" && Array.isArray(block.value)) {
      for (const item of block.value) pushSource(list, seen, item);
      continue;
    }
    const text = blockText(block);
    if (text) scrapeSources(text, list, seen);
  }
  return list;
});

// The host, as the second line of a result — a full URL is unreadable at this
// size and the domain is what tells you whether a source is worth opening.
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
</script>

<template>
  <div class="web-search" :class="{ error: failed, running: status === 'running' || status === 'pending' }">
    <div class="web-search-head">
      <span class="web-search-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="4.4" stroke="currentColor" stroke-width="1.3" />
          <path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </span>
      <span class="web-search-label">Web search</span>
      <span v-if="query" class="web-search-term">{{ query }}</span>
      <span v-if="statusLabel" class="web-search-status">{{ statusLabel }}</span>
    </div>

    <div v-if="progress && !failed && status !== 'completed'" class="web-search-progress">
      {{ progress }}
    </div>

    <p v-if="failed" class="web-search-error-text">{{ errorText }}</p>

    <div v-if="sources.length" class="web-search-results">
      <a
        v-for="source in sources"
        :key="source.url"
        class="web-search-result"
        :href="source.url"
        target="_blank"
        rel="noopener noreferrer"
        :title="source.url"
      >
        <span class="web-search-result-title">{{ source.title || hostOf(source.url) }}</span>
        <span class="web-search-result-host">{{ hostOf(source.url) }}</span>
        <span v-if="source.snippet" class="web-search-result-snippet">{{ source.snippet }}</span>
      </a>
    </div>

    <!-- A finished search with nothing to show is worth saying out loud: an
         empty card otherwise looks like a render that failed. -->
    <div v-else-if="status === 'completed' && !failed" class="web-search-empty">
      No pages returned.
    </div>
  </div>
</template>

<style scoped>
.web-search {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-raised);
  overflow: hidden;
}

.web-search.error {
  border-color: var(--error);
}

.web-search-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 12.5px;
}

.web-search-icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--msg-tool);
}

.web-search-label {
  flex-shrink: 0;
  color: var(--msg-tool);
}

.web-search-term {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--fg);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.web-search-status {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--dim);
  font-size: 11px;
}

.web-search.running .web-search-status {
  color: var(--accent);
}

.web-search.error .web-search-status {
  color: var(--error);
}

.web-search-progress {
  padding: 0 10px 6px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 11.5px;
}

.web-search-error-text {
  margin: 0;
  padding: 0 10px 7px;
  color: var(--error);
  font-family: var(--mono);
  font-size: 11.5px;
}

.web-search-results {
  display: grid;
  gap: 1px;
  padding: 6px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.web-search-result {
  display: grid;
  gap: 2px;
  padding: 6px 7px;
  border-radius: 4px;
  color: var(--fg);
  font-size: 12.5px;
  text-decoration: none;
}

.web-search-result:hover {
  background: var(--bg-raised);
}

.web-search-result-title {
  overflow: hidden;
  color: var(--accent);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.web-search-result-host {
  overflow: hidden;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.web-search-result-snippet {
  color: var(--dim);
  font-size: 11.5px;
  line-height: 1.45;
  /* Two lines is enough to judge a result by; more turns the card into a wall. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.web-search-empty {
  padding: 0 10px 7px;
  color: var(--dim);
  font-size: 11.5px;
}
</style>
