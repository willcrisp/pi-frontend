// Headless driver for pi's provider connect (`/login`) flow, spoken as
// newline-delimited JSON on stdin/stdout — the same shape the Rust server
// already bridges for `pi --mode rpc`.
//
// pi's RPC protocol has no login command: credential/OAuth orchestration is
// "app-owned" and lives in the coding-agent's ModelRuntime, not the wire
// protocol. So instead of talking to a running `pi` process, this script
// bootstraps a ModelRuntime the same way pi's interactive mode does
// (`ModelRuntime.create()`), then exposes exactly the operations the
// interactive `/login` UI drives:
//
//   runtime.getProviders() / getProviderAuthStatus() -> provider list + status
//   runtime.login(id, "oauth"|"api_key", interaction) -> connect
//   runtime.logout(id)                                 -> disconnect
//
// The `interaction` contract (see interactive-mode.js loginProvider) is
// `{ signal, prompt(p) => Promise<string>, notify(event) => void }`. We
// forward every prompt/notify to the client as an event and await a
// `prompt_response` line back — so the browser renders the auth URL, device
// code, API-key field, or select exactly like the TUI dialog would.
//
// Protocol (one JSON object per line):
//   in : {type:"list"}
//        {type:"login", providerId, method}          method: "oauth"|"api_key"
//        {type:"logout", providerId}
//        {type:"prompt_response", id, value}          value:null = cancel
//        {type:"cancel"}
//   out: {type:"ready"}
//        {type:"providers", providers:[...]}
//        {type:"prompt", id, prompt:{...}}            awaits prompt_response
//        {type:"notify", event:{...}}                 auth_url/device_code/info/progress
//        {type:"login_result", ok, providerId, error?}
//        {type:"logout_result", ok, providerId, error?}
//        {type:"error", message}

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";

// The coding-agent package dir is passed by the server (derived from the pi
// launcher location); fall back to bare-name resolution if NODE_PATH is set.
const pkgDir = process.argv[2];

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function loadRuntime() {
  let mod;
  try {
    mod = pkgDir
      ? await import(pathToFileURL(join(pkgDir, "dist/index.js")).href)
      : await import("@earendil-works/pi-coding-agent");
  } catch (e) {
    out({ type: "error", message: `failed to load pi package: ${e?.message || e}` });
    process.exit(1);
  }
  if (!mod.ModelRuntime) {
    out({ type: "error", message: "pi package has no ModelRuntime export (incompatible pi version)" });
    process.exit(1);
  }
  // Network on: OAuth and catalog refresh need it. create() self-limits with a timeout.
  return await mod.ModelRuntime.create({ allowModelNetwork: true });
}

// Build the provider list mirroring interactive-mode's getLoginProviderOptions:
// one entry per provider, carrying which auth methods it supports and its
// current connection status.
function providerList(runtime) {
  const providers = [];
  for (const p of runtime.getProviders()) {
    let status;
    try {
      const s = runtime.getProviderAuthStatus?.(p.id);
      if (s?.configured) {
        status = {
          type: runtime.isUsingOAuth?.(p.id) ? "oauth" : "api_key",
          source: s.label ?? s.source,
        };
      }
    } catch {
      // status is best-effort; a provider that can't be inspected is just "not connected"
    }
    providers.push({
      id: p.id,
      name: p.name,
      oauth: !!p.auth?.oauth,
      apiKey: !!p.auth?.apiKey,
      // interactive shows a manual API-key entry only when the method exposes a login step
      apiKeyManual: !!p.auth?.apiKey?.login,
      status: status ?? null,
    });
  }
  providers.sort((a, b) => a.name.localeCompare(b.name));
  return providers;
}

// One prompt outstanding at a time (login flows are sequential). We hand the
// resolver to the stdin dispatcher via this slot.
let pendingPrompt = null;
let promptSeq = 0;
let activeAbort = null;

function askClient(prompt) {
  const id = `p${++promptSeq}`;
  return new Promise((resolve) => {
    pendingPrompt = { id, resolve };
    // Strip the non-serializable signal before sending to the client.
    const { signal, ...wire } = prompt;
    out({ type: "prompt", id, prompt: wire });
  });
}

async function doLogin(runtime, providerId, method) {
  activeAbort = new AbortController();
  const interaction = {
    signal: activeAbort.signal,
    prompt: (prompt) => askClient(prompt),
    notify: (event) => out({ type: "notify", event }),
  };
  try {
    await runtime.login(providerId, method, interaction);
    out({ type: "login_result", ok: true, providerId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out({ type: "login_result", ok: false, providerId, error: msg });
  } finally {
    activeAbort = null;
    pendingPrompt = null;
  }
}

async function doLogout(runtime, providerId) {
  try {
    await runtime.logout(providerId);
    out({ type: "logout_result", ok: true, providerId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out({ type: "logout_result", ok: false, providerId, error: msg });
  }
}

async function main() {
  const runtime = await loadRuntime();
  out({ type: "ready" });

  const rl = createInterface({ input: process.stdin });
  let busy = false;

  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      out({ type: "error", message: "invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "prompt_response": {
        // value === null means the user cancelled the dialog step.
        if (pendingPrompt && (!msg.id || msg.id === pendingPrompt.id)) {
          const p = pendingPrompt;
          pendingPrompt = null;
          if (msg.value === null || msg.value === undefined) {
            activeAbort?.abort();
            // Resolve with empty so the flow's own cancel/abort path unwinds.
            p.resolve("");
          } else {
            p.resolve(String(msg.value));
          }
        }
        return;
      }
      case "cancel": {
        activeAbort?.abort();
        return;
      }
      case "list": {
        (async () => {
          try {
            await runtime.getAvailable();
          } catch {
            // availability refresh is best-effort; list what we have regardless
          }
          out({ type: "providers", providers: providerList(runtime) });
        })();
        return;
      }
      case "login": {
        if (busy) {
          out({ type: "login_result", ok: false, providerId: msg.providerId, error: "another login is in progress" });
          return;
        }
        busy = true;
        doLogin(runtime, msg.providerId, msg.method).finally(() => {
          busy = false;
          out({ type: "providers", providers: providerList(runtime) });
        });
        return;
      }
      case "logout": {
        doLogout(runtime, msg.providerId).finally(() => {
          out({ type: "providers", providers: providerList(runtime) });
        });
        return;
      }
      default:
        out({ type: "error", message: `unknown command: ${msg.type}` });
    }
  });

  rl.on("close", () => process.exit(0));
}

main().catch((e) => {
  out({ type: "error", message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
