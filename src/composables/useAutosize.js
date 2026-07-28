// Grow a textarea to fit its content (capped by the CSS max-height, past which
// it scrolls).
import { onBeforeUnmount, onMounted, watch } from "vue";

export function useAutosize(textareaEl, value) {
  // Measuring needs the height released first, hence the "auto" pass.
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
  // The caller's @input handler stays as well: v-model holds updates back during
  // IME composition, and the box should still grow while a long phrase is composed.
  watch(value, autosize, { flush: "post" });

  onMounted(() => {
    autosize();
    // A narrower composer re-wraps the text into more lines, so the fitted
    // height has to be recomputed.
    window.addEventListener("resize", autosize);
  });
  onBeforeUnmount(() => window.removeEventListener("resize", autosize));

  return autosize;
}
