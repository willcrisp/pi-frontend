// Parse whatever the user typed into the connect screen's one address field.
//
// One field rather than the desktop's host + port, because the two ways of
// reaching a server look nothing alike and both are things you paste:
//
//   https://4096--main--ws--you.coder.example.com   a Coder port-forward URL
//   192.168.1.5:4096                                a machine on the same Wi-Fi
//   100.94.0.3                                      a Tailscale address
//
// Splitting that by hand into host and port on a phone keyboard is exactly the
// kind of friction this build exists to remove — and the Coder case has no port
// to split out at all, since it is encoded in the hostname and served on 443.
//
// Returns { host, port, secure } or null when there is nothing usable.

// Defaults differ by scheme: an https URL with no port is 443, and anything else
// is opencode2's own default.
const DEFAULT_TLS_PORT = 443;
const DEFAULT_PORT = 4096;

export function parseAddress(raw) {
  let text = String(raw || "").trim();
  if (!text) return null;

  let secure = false;
  const scheme = text.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    // Anything other than http/https is a typo, not a protocol we can use.
    if (name !== "http" && name !== "https") return null;
    secure = name === "https";
    text = text.slice(scheme[0].length);
  }

  // A pasted URL usually brings a path, query or fragment with it. The server's
  // own /api prefix is added by apiBase(), so anything after the authority is
  // noise — and silently keeping it would produce a URL that 404s with no clue
  // why.
  text = text.split(/[/?#]/)[0];
  if (!text) return null;

  let host = text;
  let port = null;
  // Split on the LAST colon so an IPv6 literal in brackets survives; a bare IPv6
  // address is not supported and would be ambiguous here anyway.
  const colon = text.lastIndexOf(":");
  if (colon > 0 && text.indexOf("]") < colon) {
    const tail = text.slice(colon + 1);
    if (/^\d+$/.test(tail)) {
      host = text.slice(0, colon);
      port = Number(tail);
    }
  }

  host = host.replace(/^\[|\]$/g, "");
  if (!host) return null;
  if (port === null) port = secure ? DEFAULT_TLS_PORT : DEFAULT_PORT;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  return { host, port, secure };
}

/** How a parsed address reads back to the user, so the guesses above are visible. */
export function describeAddress(parsed) {
  if (!parsed) return "";
  return `${parsed.secure ? "https" : "http"}://${parsed.host}:${parsed.port}`;
}
