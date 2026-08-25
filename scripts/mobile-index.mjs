// Rename dist-mobile/mobile.html -> index.html.
//
// Vite names the output after the input document, but a WebView (and the
// in-app proxy) asks for `/` and expects index.html. Doing it here rather than
// renaming the source keeps `npm run dev:mobile` serving a URL that matches the
// desktop entry's convention.
import { rename, access } from "node:fs/promises";

const dir = new URL("../dist-mobile/", import.meta.url);
try {
  await access(new URL("mobile.html", dir));
  await rename(new URL("mobile.html", dir), new URL("index.html", dir));
} catch {
  /* already index.html (a rebuild without a clean) — nothing to do */
}
