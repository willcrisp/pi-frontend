// POST /api/session/:id/prompt — the one route both sendPrompt and sendSteer go
// through, isolated here because it carries two build divergences that are easy
// to "simplify" into a runtime 400.
//
// --- Delivery mode -----------------------------------------------------------
// The route takes a delivery mode, which is what makes steering possible at all.
// Verified against a live server's openapi.json (build 0.0.0-next-202606270058)
// and by probing the route:
//
//   steer  — admitted into the run that is ALREADY GOING. The agent reads it at
//            its next turn, without the run being interrupted or the tool it is
//            mid-way through being lost.
//   queue  — held back until the current run ends, then promoted as its own turn.
//
// The server DEFAULTS to "steer" when the field is absent, and both modes are
// accepted on an idle session too (there the mode is moot — the input is
// promoted immediately and starts a run). The UI only sends "steer"; "queue" is
// the same call with a different hand-off point, kept as sendSteer's argument.
//
// A 200 answers with `SessionInput.Admitted`:
//   {admittedSeq, id: "msg_…", sessionID, prompt, delivery, timeCreated, promotedSeq?}
// `promotedSeq` only appears once the agent has taken the input. Until then the
// input is invisible to GET /session/:id/message — see steer.js.
//
// --- Body shape --------------------------------------------------------------
// Two body shapes for this one route are in the wild and the difference is a
// 400, not a warning: some builds take a FLAT PromptInput
// (`{text, files?, agents?, delivery?, resume?}` — what the ALF-UAT target
// wants), while the current opencode-ai@next wraps it
// (`{prompt: {text, files?, agents?}, delivery?, resume?, id?}`) and rejects a
// flat body with "Missing key at [\"prompt\"]". Rather than pick one and break
// the other, the first shape that works is remembered and reused; a 400 costs
// one retry, once per page load.
//
// ⚠️ Do not collapse this to a single shape.
import { apiPost } from "../../lib/api.js";

let promptBodyShape = "flat";

function promptBody(shape, prompt, extras) {
  return shape === "wrapped" ? { prompt, ...extras } : { ...prompt, ...extras };
}

// POST a prompt, transparently falling back to the other body shape. Returns
// the Response — the caller owns status handling, and nothing has read the body.
export async function postPrompt(sessionID, prompt, extras = {}) {
  const send = (shape) =>
    apiPost(`/session/${sessionID}/prompt`, promptBody(shape, prompt, extras));

  const res = await send(promptBodyShape);
  // Only a shape mismatch is worth a second try, and only a 400 can be one.
  if (res.status !== 400) return res;

  const alternate = promptBodyShape === "flat" ? "wrapped" : "flat";
  const retry = await send(alternate);
  if (!retry.ok) return res; // both shapes rejected it — the first error is the real one
  promptBodyShape = alternate;
  return retry;
}

// Composer attachments are `{ filename, mime, url }` where `url` is a
// `data:<mime>;base64,...` URL. The wire shape is different and strict:
// `PromptInput.FileAttachment` is `{uri, name?, description?, mention?}` with
// `additionalProperties: false`, so sending `{filename, mime, url}` 400s. The
// server parses the data URI and stores it as
// `{data, mime, source: {type: "inline"}, name}`.
export function promptWithFiles(text, attachments) {
  return attachments.length
    ? { text, files: attachments.map((f) => ({ uri: f.url, name: f.filename })) }
    : { text };
}
