// Waiting-for-the-agent text: a random silly gerund instead of a flat
// "OpenCode is thinking…". Purely decorative — nothing reads these back.
const PHRASES = [
  "Pondering",
  "Percolating",
  "Ruminating",
  "Noodling",
  "Marinating",
  "Cogitating",
  "Incubating",
  "Deliberating",
  "Untangling",
  "Rummaging",
  "Spelunking",
  "Divining",
  "Conjuring",
  "Summoning",
  "Consulting the oracle",
  "Reticulating splines",
  "Herding electrons",
  "Bribing the compiler",
  "Waking the hamsters",
  "Feeding the hamsters",
  "Warming up the tubes",
  "Shuffling the deck",
  "Counting to infinity",
  "Reversing the polarity",
  "Aligning the crystals",
  "Consulting the runes",
  "Rearranging the furniture",
  "Chasing loose ends",
  "Doing the needful",
  "Wrangling the semicolons",
  "Blaming the cache",
  "Rewriting it in Rust",
  "Arguing with itself",
  "Overthinking it",
  "Sharpening the pencils",
  "Staring into the middle distance",
  "Brewing something",
  "Consulting the manual it didn't read",
  "Yak shaving",
  "Bikeshedding",
  "Vibing",
  "Assembling the pieces",
  "Turning it off and on again",
  "Composing itself",
  "Lost in thought",
  "Doing math in its head",
  "Checking under the couch",
  "Pretending to read the docs",
  "Untangling the headphones",
  "Ordering its thoughts",
];

// A phrase that isn't the one on screen, so a rotation always looks like it
// changed something.
export function randomThinkingPhrase(previous) {
  if (PHRASES.length < 2) return PHRASES[0];
  let next = previous;
  while (next === previous) {
    next = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  }
  return next;
}
