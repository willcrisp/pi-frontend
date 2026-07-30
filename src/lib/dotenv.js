// Minimal .env parsing — enough for reading a credential out of a file on the
// OpenCode host, not a general implementation of the format.
//
// Deliberately narrow: no variable interpolation (`$OTHER`), no multi-line
// values, no `\n` unescaping. Those turn a value into something other than what
// the file literally says, and a credential that has been silently transformed
// fails at the gateway with an error that points nowhere near the cause.

// { KEY: value } for a .env file's contents. Later duplicates win, matching how
// a shell sourcing the file would end up.
export function parseEnv(text) {
  const out = {};
  if (!text) return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // `export KEY=value` is common in files meant to be sourced as well as read.
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    // Quoted values keep everything inside the quotes, including a `#` that
    // would otherwise read as a trailing comment.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}
