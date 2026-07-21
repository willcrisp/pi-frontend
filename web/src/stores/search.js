// REST client + reactive store for cross-chat content search, scoped to the
// current project (see GET /api/projects/{id}/search in server/src/main.rs).
// Consumed by CommandPalette.vue, which appends message-content matches
// below its existing fuzzy project/title matches once the query is long
// enough to be worth a server round-trip.
//
// Key exports:
//   searchStore                      — {projectId, query, results, loading, error}
//   searchMessages(projectId, query)  — GET .../search?q=...; results are
//                                        [{ path, title, mtimeMs, snippet, matchCount }].
//                                        Drops stale responses by request
//                                        sequence number, so a slow older
//                                        request can never clobber a newer one.
//   resetSearch()                     — clears results (e.g. query shrinks
//                                        back below the palette's threshold)
import { reactive } from "vue";

export const searchStore = reactive({
  projectId: null,
  query: "",
  results: [], // [{ path, title, mtimeMs, snippet, matchCount }]
  loading: false,
  error: "",
});

// Bumped on every call and on reset; a response is only applied if its
// sequence is still the latest one issued, so out-of-order network replies
// can't overwrite a newer search's results.
let seq = 0;

export async function searchMessages(projectId, query) {
  const mySeq = ++seq;
  const trimmed = (query || "").trim();
  if (!projectId || trimmed.length < 2) {
    searchStore.results = [];
    return;
  }
  searchStore.loading = true;
  try {
    const res = await fetch(`/api/projects/${projectId}/search?q=${encodeURIComponent(trimmed)}`);
    if (mySeq !== seq) return; // superseded by a newer search
    if (!res.ok) {
      searchStore.error = `failed to reach server (${res.status})`;
      searchStore.results = [];
      return;
    }
    const data = await res.json();
    if (mySeq !== seq) return;
    searchStore.projectId = projectId;
    searchStore.query = trimmed;
    searchStore.results = Array.isArray(data) ? data : [];
    searchStore.error = "";
  } catch (e) {
    if (mySeq !== seq) return;
    searchStore.error = e.message || String(e);
    searchStore.results = [];
  } finally {
    if (mySeq === seq) searchStore.loading = false;
  }
}

export function resetSearch() {
  seq++; // invalidate any in-flight request so it can't land after this
  searchStore.projectId = null;
  searchStore.query = "";
  searchStore.results = [];
  searchStore.loading = false;
  searchStore.error = "";
}
