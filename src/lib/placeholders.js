// Composer placeholder text.
//
// The quote is the only always-visible copy in the app, and in an empty chat it
// was also the only thing where an instruction should have been: a first-time
// user got "The ships hung in the sky in much the same way that bricks don't."
// where they needed to know that "/" and "@" do something. So the quote is now
// what you see once a chat has started, and an empty one says what the box does.
// See composerPlaceholder in components/chat/Composer.vue.
export const EMPTY_CHAT_PLACEHOLDER = "Ask for anything — / for commands, @ for files";

// Purely decorative — nothing reads these back.
const SCI_FI_QUOTES = [
  "I must not fear. Fear is the mind-killer. — Dune",
  "It is by will alone I set my mind in motion. — Dune",
  "The ships hung in the sky in much the same way that bricks don't. — The Hitchhiker's Guide to the Galaxy",
  "Space is big. You just won't believe how vastly, hugely, mind-bogglingly big it is. — The Hitchhiker's Guide to the Galaxy",
  "Don't Panic. — The Hitchhiker's Guide to the Galaxy",
  "The sky above the port was the color of television, tuned to a dead channel. — Neuromancer",
  "So it goes. — Slaughterhouse-Five",
  "All this happened, more or less. — Slaughterhouse-Five",
  "Violence is the last refuge of the incompetent. — Foundation",
  "The enemy's gate is down. — Ender's Game",
  "That is not dead which can eternal lie. — At the Mountains of Madness",
  "Life before death. Strength before weakness. Journey before destination. — The Way of Kings",
  "The most important step a man can take is the next one. — Oathbringer",
  "Journey before destination. — Words of Radiance",
  "I've a hankering to be a hero. — Mistborn: The Final Empire",
  "There's always another secret. — Mistborn: The Well of Ascension",
  "Not all those who wander are lost. — The Fellowship of the Ring",
  "All we have to decide is what to do with the time that is given us. — The Fellowship of the Ring",
  "It's a dangerous business, going out your door. — The Hobbit",
  "A wizard is never late. — The Fellowship of the Ring",
  "The wheel weaves as the wheel wills. — The Wheel of Time",
  "It's like the people who believe they'll be happy if they go and live somewhere else. — The Colour of Magic",
  "Words are pale shadows of forgotten names. — The Name of the Wind",
  "It's the questions we can't answer that teach us the most. — The Wise Man's Fear",
  "When you play the game of thrones, you win or you die. — A Game of Thrones",
  "A reader lives a thousand lives before he dies. — A Dance with Dragons",
  "To light a candle is to cast a shadow. — A Wizard of Earthsea",
  "The unread story is not a story. — The Language of the Night",
];

export function randomPlaceholder() {
  return SCI_FI_QUOTES[Math.floor(Math.random() * SCI_FI_QUOTES.length)];
}
