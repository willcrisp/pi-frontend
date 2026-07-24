// One-shot remote command execution via the OpenCode V2 PTY API.
// Spins up a PTY, streams its output over the WebSocket connect route until the
// process exits, then tears the PTY down. Not a persistent-shell abstraction —
// callers get back the captured text of one command's run.
//
// Endpoint shapes here come from the hosted OpenCode V2 API docs (v2.opencode.ai),
// not a verified live-server /doc — re-check field names against your target
// server's /doc if something doesn't line up (see docs/opencode-api.md).
import { apiBase, authHeaders } from "./ssh.js";

function wsBase() {
  const base = apiBase(); // e.g. "/api/4096/api"
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${base}`;
}

// Runs `command` with `args` in `cwd` on the connected opencode server, returns the
// captured stdout/stderr text once the PTY session reports status "exited".
export async function runCommand(cwd, command, args = [], { timeoutMs = 15000 } = {}) {
  const createRes = await fetch(`${apiBase()}/pty`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ command, args, cwd, title: `${command} ${args.join(" ")}`.trim() }),
  });
  if (!createRes.ok) {
    throw new Error(`pty create failed (${createRes.status}): ${command} ${args.join(" ")}`);
  }
  const created = await createRes.json();
  const ptyId = created?.data?.id ?? created?.id;
  if (!ptyId) throw new Error("pty create response had no id");

  try {
    return await streamUntilExit(ptyId, timeoutMs);
  } finally {
    fetch(`${apiBase()}/pty/${ptyId}`, { method: "DELETE", headers: authHeaders() }).catch(() => {});
  }
}

async function streamUntilExit(ptyId, timeoutMs) {
  const tokenRes = await fetch(`${apiBase()}/pty/${ptyId}/connect-token`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!tokenRes.ok) throw new Error(`pty connect-token failed (${tokenRes.status})`);
  const tokenBody = await tokenRes.json();
  const token = tokenBody?.data?.token ?? tokenBody?.token;

  return new Promise((resolve, reject) => {
    const url = `${wsBase()}/pty/${ptyId}/connect${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const ws = new WebSocket(url);
    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`pty command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(output);
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        // Some servers frame exit status as a JSON control message rather than raw bytes.
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === "exit") return finish();
          if (msg && msg.status === "exited") return finish();
        } catch {
          output += ev.data;
        }
      }
    };
    ws.onerror = () => finish(new Error("pty websocket error"));
    ws.onclose = () => finish();
  });
}
