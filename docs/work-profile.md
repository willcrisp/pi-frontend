# Work profile

What kind of work you have been doing, per session and in aggregate, drawn as a
radar over eight categories. The header chip labels the chat on screen; clicking
it opens the whole profile.

This is the design record. The code is:

| Piece | File |
|---|---|
| taxonomy, signals, scoring, the classifier prompt | `src/lib/workcategories.js` |
| the three tiers, the cache, the aggregate | `src/stores/workprofile.js` |
| radar, ranked bars, session list | `src/components/dialogs/WorkProfileDialog.vue` |
| the live chip | `src/components/chat/ChatHeader.vue` + `styles/header.css` |
| hiding the classifier's session | `src/stores/projects.js#rootSessions` |

## The categories

Eight, fixed order, ids frozen: `frontend`, `backend`, `data`, `infra`,
`security`, `testing`, `docs`, `tooling`.

Eight is a deliberate ceiling, not a starting point. The radar has one spoke per
category and a nine-spoke polygon stops being a shape you can read at a glance;
more usefully, every category added is one more way for a session's mix to be
split across near-synonyms, so a real signal thins out into two weak ones. Add
one only if work is genuinely landing nowhere, and bump `TAXONOMY_VERSION` when
you do — the cached scores are keyed by id, so a taxonomy change makes every
stored classification meaningless rather than merely stale. The version stamp is
what evicts them.

## The three tiers

Each exists because the one below it isn't good enough, and each costs more.

### 1. Titles — free

Every session in the sidebar list already carries a server-written title, so the
entire history is classifiable the instant the dialog opens, with no request at
all. It is also the weakest evidence there is: "Fix the thing" classifies as
nothing, and "Mock session" classifies as *testing* because `mock` is a testing
word. The panel always reports how much of the shape rests on titles alone.

### 2. Transcripts — one request per session

`GET /session/:id/message` per session, at a concurrency of 4 (firing 200
requests at someone's real server because their history is long would be a
denial of service we wrote ourselves).

The evidence extracted from a transcript is, in order of weight:

| Channel | Weight | Why |
|---|---|---|
| file paths in tool inputs | 3 | What actually happened. A turn that edited four `.vue` files was frontend work whatever anyone called it. |
| tool names | 2 | Weak — `read` says nothing — so only tools that are themselves a kind of work count. |
| the session title | 2.5 | |
| the user's prompts | 1 | What was *asked for*, which is not always what was done. |

Two rules in here have teeth:

- **Only the user's turns contribute prose.** An agent narrating "I'll add a test
  for this CSS change" would otherwise drag the session toward testing on the
  strength of its own commentary. Its *tool calls* are read, because those are
  the record of what was done.
- **A pattern scores its category once per channel**, not once per occurrence.
  Otherwise a prompt that says "test" nine times outranks the session that
  quietly rewrote the whole test suite.

Paths are pulled out of the stringified tool input rather than off a list of
known argument names (`file_path`, `path`, `notebook_path`, or buried in a bash
command line) — a list of key names is wrong for the next tool that ships.

### 3. A model — opt-in, costs tokens

For the sessions the regexes genuinely can't call, and only those: the button
offers exactly the weak ones. A compact digest (title, last prompts, files,
tools) goes to the model with `buildClassifierPrompt()`, which asks for **only** a
JSON object of `category → 0-100`. Two of its rules earn their words:

- *"Use only ids from the list"* — a model left to itself invents `devops`, and
  the score lands on a key nobody reads.
- *"Omit a category rather than guess"* — what keeps an ambiguous session
  honestly thin instead of evenly smeared across all eight axes.

`parseClassifierReply()` is tolerant on the way back: it digs the first `{...}`
out of the text, so a model that ignores "no code fence" is still understood.
Dropping a paid-for answer on a formatting technicality is the worse failure —
the mock replies inside a fence on purpose, so the parser is tested against it.

## The classifier session

The model pass has to run *somewhere*, and **V2 has no session delete**. A scratch
session per classification would fill the sidebar with rubbish that can never be
cleared. So:

- one session is created on first use, its id kept in localStorage
  (`opencode-web:workprofile:classifierSession`), and reused forever;
- `projects.js#rootSessions` filters it out of the sidebar;
- `profileScope()` excludes it from the profile — classifying is not work you did;
- it is **not** excluded from the usage view, because those tokens were really
  spent and hiding them would be a lie about cost.

The id is verified against the session list before use, never trusted straight
from storage: the connect dialog can be repointed at any server, and the stored
id may belong to a different one entirely.

Prompts are sent with `delivery: "queue"` and **one at a time**. Steering them in
together would merge them into a single run, where the second answer reads the
first session's evidence as context — a classifier that has been told about the
previous chat is not classifying this one.

The answer is read by **polling** `GET /session/:id/message`, not off the SSE
stream. `events.js` routes events into the transcript of the chat on screen, and
this session is deliberately not that; teaching the reducer about a session the
user can't see would put a machine's bookkeeping in the middle of the code that
renders chats. Polling a session nobody is watching stays inside `workprofile.js`.

## The aggregate, and what the radar is

A session's scores are normalised to **sum to 1** — a session is a *mix* of work,
not a quantity of it. The aggregate sums those mixes, weighted either by tokens
("where did the context window actually go") or one-per-session, and
re-normalises, so the whole history and a single chat are drawn on the same
scale.

Zero is a real answer. When nothing matches, the scores are all zero and the
dialog says "nothing classified" — an even eight-way split would be a lie the
radar tells very convincingly.

The polygon is scaled so the **outer ring is the largest value on either series**
(the overlay shares the scale, or the comparison would be against a different
ruler), and the ring is labelled with that percentage. The radar answers "am I
lopsided?" and nothing else does — but a polygon is poor at precise comparison,
so every axis is also a labelled bar underneath, which doubles as the table view.

Colour does no identity work: the categories are named on their axes and in the
bars. The only two hues are the two *series* — all work (`#4f86e0`) and the
project overlay (`#cf7a45`) — chosen to clear contrast and colour-vision
separation against the panel surface.

## Caching

Tier 2 and 3 results are cached in localStorage against a fingerprint of the
session (its `updatedAt`). A session worked on since is marked **stale**, never
discarded automatically: a model classification was paid for, and re-spending
that on every refresh would be a bill nobody asked for. Title-pass results are
not cached at all — recomputing them is microseconds, and caching would only
create a way for a stale one to outlive the title it came from.
