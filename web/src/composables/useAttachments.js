// Composer file attachments: paste, drag-and-drop, the paperclip picker, and
// image markup.
//
// Attachments live only until the prompt is sent. Each entry is a FilePart
// (`{filename, mime, url}` with a base64 data URL) plus a local `id` for keying.
// The data URL is what the wire format needs (see
// stores/opencode/transport.js#promptWithFiles) and what the thumbnail renders
// from, so there is no separate object URL to revoke.
import { computed, ref } from "vue";
import { opencodeStore as store } from "../stores/opencode.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export function useAttachments() {
  const attachments = ref([]);
  const dragging = ref(false);
  let seq = 0;

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
          id: `att-${seq++}`,
          // Pasted screenshots arrive as a nameless blob; give them something readable.
          filename: file.name || `pasted-${Date.now()}.${file.type.split("/")[1] || "bin"}`,
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

  // --- Image markup ---------------------------------------------------------
  // The pencil on an image chip opens ImageAnnotator; saving replaces that
  // attachment's data URL with the flattened PNG (always PNG, since the
  // annotator re-encodes through a canvas).
  const annotatingId = ref("");
  const annotating = computed(
    () => attachments.value.find((a) => a.id === annotatingId.value) || null
  );

  function onAnnotated(dataUrl) {
    const att = annotating.value;
    if (att) {
      att.url = dataUrl;
      att.mime = "image/png";
      att.filename = att.filename.replace(/\.[^.]+$/, "") + ".png";
    }
    annotatingId.value = "";
  }

  // Strip the local `id` — only the FilePart fields go to the server.
  function toPromptFiles() {
    return attachments.value.map(({ filename, mime, url }) => ({ filename, mime, url }));
  }

  function clear() {
    attachments.value = [];
  }

  return {
    attachments,
    dragging,
    annotating,
    annotatingId,
    addFiles,
    removeAttachment,
    onPaste,
    onDrop,
    onDragOver,
    onPickFiles,
    isImage,
    onAnnotated,
    toPromptFiles,
    clear,
  };
}
