// Click handling for the copy buttons renderMarkdown() plants in fenced code
// blocks.
//
// The rendered markdown lands in `v-html`, so the button cannot carry a Vue
// listener of its own — the component that owns the container delegates its
// clicks here instead (MessageView, SubagentView). The button's two visual
// states are pure CSS: `.code-copy::before` renders "copy", and `.copied`
// swaps it to "copied" (see styles/message-actions.css).

// How long the button stays in its "copied" state.
const RESET_MS = 1200;

// Per-button reset timers, so a second click restarts the window instead of
// having the first click's timer clear the label early.
const timers = new WeakMap();

function flash(button) {
  button.classList.add("copied");
  clearTimeout(timers.get(button));
  timers.set(
    button,
    setTimeout(() => {
      button.classList.remove("copied");
      timers.delete(button);
    }, RESET_MS)
  );
}

// navigator.clipboard only exists in a secure context. Opening the harness over
// plain http on a forwarded port — the documented remote workflow — is not one,
// so the legacy selection-based copy is a real fallback here, not a museum
// piece for old browsers.
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off-screen but still focusable; `display:none` cannot be selected.
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied or non-secure context — fall through */
  }
  return legacyCopy(text);
}

// Delegated click handler. Bind to any element containing rendered markdown;
// clicks that aren't on a copy button pass straight through untouched.
export function onMarkdownClick(e) {
  const button = e.target?.closest?.(".code-copy");
  if (!button) return;
  // The button sits inside <pre>, which may itself be inside a <summary> or
  // other click-sensitive chrome — don't let the copy toggle anything.
  e.preventDefault();
  e.stopPropagation();

  const code = button.parentElement?.querySelector("code");
  if (!code) return;
  copyText(code.textContent || "").then((ok) => {
    if (ok) flash(button);
  });
}
