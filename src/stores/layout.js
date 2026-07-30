// Whether the window is too narrow for the two-column shell, and whether the
// sidebar is currently showing as an overlay drawer.
//
// The app had no responsive behaviour at all: four @media rules in the whole
// tree, none of them touching the sidebar, header or composer. The sidebar is a
// fixed 260px, so at 420px the chat column measured 160px — the header's controls
// sat outside it, the page scrolled sideways, and every user prompt wrapped after
// its first character. On a laptop at half-screen it was merely cramped, which is
// the width people actually use.
//
// Layout is CSS's job (styles/responsive.css); this store owns only the one bit
// CSS can't hold — is the drawer open — plus the media query that decides whether
// a drawer is what the sidebar is right now.
import { reactive } from "vue";

// Below this the sidebar overlays the chat instead of sitting beside it. Chosen
// so the chat column keeps a readable measure at the narrow end: 900 − 260 is
// still comfortable, much below it is not.
export const NARROW_PX = 900;

export const layoutStore = reactive({
  narrow: false,
  sidebarOpen: false,
});

// `matchMedia` rather than a resize listener: it fires only on the transition
// that matters, and reports correctly on first paint.
const query = window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`);

function apply(matches) {
  layoutStore.narrow = matches;
  // Leaving narrow mode means the sidebar is docked again, and a drawer left
  // "open" would otherwise keep its backdrop alive over a two-column layout.
  if (!matches) layoutStore.sidebarOpen = false;
}

apply(query.matches);
query.addEventListener("change", (e) => apply(e.matches));

export function toggleSidebar() {
  layoutStore.sidebarOpen = !layoutStore.sidebarOpen;
}

// Escape dismisses the drawer, matching every other overlay in the app. Claimed
// with preventDefault so the composer's Escape-to-interrupt doesn't also fire —
// the drawer is listed in its ESCAPE_OWNERS for the same reason.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !layoutStore.sidebarOpen) return;
  e.preventDefault();
  layoutStore.sidebarOpen = false;
});

export function closeSidebar() {
  layoutStore.sidebarOpen = false;
}

// Picking a session is the drawer's whole purpose, so it dismisses itself
// afterwards — but only when it is a drawer. Docked, it must stay put.
export function closeSidebarIfDrawer() {
  if (layoutStore.narrow) layoutStore.sidebarOpen = false;
}
