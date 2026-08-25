// Lift dist-mobile/mobile/index.html up to dist-mobile/index.html.
//
// Vite mirrors the entry document's path into the output, so an entry at
// mobile/index.html builds to dist-mobile/mobile/index.html. The WebView and the
// in-app proxy both ask for `/`, so it has to end up at the top. Doing it here
// rather than moving the source keeps the mobile build's files together in one
// folder, which is the point of that folder.
import { rename, rm, access } from "node:fs/promises";

const dist = new URL("../dist-mobile/", import.meta.url);
const nested = new URL("mobile/index.html", dist);

try {
  await access(nested);
  await rename(nested, new URL("index.html", dist));
  await rm(new URL("mobile/", dist), { recursive: true, force: true });
} catch {
  /* already flattened (a rebuild without a clean) — nothing to do */
}
