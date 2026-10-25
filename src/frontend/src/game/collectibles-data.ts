// Rare collectibles: catalog, values and bottle-letter lore. Pure data – no
// three.js import, so the store (state.ts) and the menu UI can use it without
// pulling the 3D world in. The 3D builders live in collectibles-models.ts,
// spawning/pickup in collectibles.ts, the display case in MenuCollection.tsx.
//
// Uniqueness rule: every entry is a singular piece. A variant the player owns
// (state.ts `collection`) never spawns again; only if it ever left the
// collection (no mechanic does that today) may exactly this piece turn up
// again. Values are fictional in-game dollars (appraisal only, whole cents) –
// they are never paid out anywhere.
//
// The ids are SAVE KEYS: once a build has shipped they must never change.

export type CollectibleKind = "fossil" | "coin" | "bottle" | "jewellery";

export interface CollectibleDef {
  id: string;
  kind: CollectibleKind;
  name: string;
  /** One-line display-case description (era, material, where it turns up). */
  desc: string;
  /** Appraised value in whole cents – display only, never paid out. */
  valueCents: number;
  /** The letter inside (message bottles only) – readable in the display case. */
  letter?: string;
}

export const KIND_NAMES: Record<CollectibleKind, string> = {
  fossil: "Fossils",
  coin: "Old coins",
  bottle: "Messages in bottles",
  jewellery: "Jewellery",
};

export const COLLECTIBLE_KINDS: readonly CollectibleKind[] = [
  "fossil",
  "coin",
  "bottle",
  "jewellery",
];

export const COLLECTIBLES: CollectibleDef[] = [
  // -------------------------------------------------------------- fossils --
  {
    id: "fossil_ammonite",
    kind: "fossil",
    name: "Ribbed ammonite",
    desc: "A Jurassic sea snail's spiral, ~180 million years old; the winter storms wash them out of the clay under the east cliffs.",
    valueCents: 12000,
  },
  {
    id: "fossil_trilobite",
    kind: "fossil",
    name: "Slate trilobite",
    desc: "An Ordovician sea-floor crawler pressed into slate – older than fish, older than trees, older than insects.",
    valueCents: 9500,
  },
  {
    id: "fossil_shark_tooth",
    kind: "fossil",
    name: "Megalodon tooth",
    desc: "Serrated tooth of a giant Miocene shark; the enamel still holds its edge after twenty million years in the sand.",
    valueCents: 34000,
  },
  {
    id: "fossil_urchin",
    kind: "fossil",
    name: "Shepherd's crown",
    desc: "A flint heart urchin from the chalk; downland folk kept them on the windowsill to turn the thunder away.",
    valueCents: 4500,
  },
  {
    id: "fossil_fern",
    kind: "fossil",
    name: "Fern shale",
    desc: "A Carboniferous fern frond in split shale – a leaf that last saw sunlight three hundred million years before grass existed.",
    valueCents: 6800,
  },
  {
    id: "fossil_amber",
    kind: "fossil",
    name: "Baltic amber",
    desc: "A knuckle of fossil resin with a midge caught inside; it drifted the whole North Sea to end up on this beach.",
    valueCents: 39500,
  },

  // ---------------------------------------------------------------- coins --
  {
    id: "coin_real",
    kind: "coin",
    name: "Piece of eight",
    desc: "A hammered silver eight-real piece, minted in Potosí and lost with some unlucky ship; salt has blacked the cross.",
    valueCents: 9500,
  },
  {
    id: "coin_denarius",
    kind: "coin",
    name: "Roman denarius",
    desc: "A legionary's day wage in worn silver; two thousand years of thumbs have nearly kissed the emperor away.",
    valueCents: 18500,
  },
  {
    id: "coin_doubloon",
    kind: "coin",
    name: "Gold doubloon",
    desc: "A Spanish two-escudo piece. Gold does not tarnish – it shines exactly as it did the day the sea took it.",
    valueCents: 58500,
  },
  {
    id: "coin_penny",
    kind: "coin",
    name: "Hammered penny",
    desc: "A medieval silver penny, clipped around the rim by someone with cold hands and no scruples.",
    valueCents: 7500,
  },
  {
    id: "coin_sovereign",
    kind: "coin",
    name: "Victoria sovereign",
    desc: "A gold sovereign of 1887 – pocket money for an empire, dropped between the dunes on some long-forgotten Sunday walk.",
    valueCents: 42000,
  },
  {
    id: "coin_cash",
    kind: "coin",
    name: "Chinese cash coin",
    desc: "Cast bronze with a square hole, green with a century of verdigris; ballast spill from a tea clipper, most likely.",
    valueCents: 2800,
  },

  // -------------------------------------------------------------- bottles --
  {
    id: "bottle_castaway",
    kind: "bottle",
    name: "The keeper's log",
    desc: "A dark Victorian wine bottle crusted with barnacles; the last entry of a lighthouse log is still dry inside.",
    valueCents: 900,
    letter:
      "Final entry, Pengarrow Head light, 14th of March, 1893.\n" +
      "The Board has seen fit to retire both the light and its keeper, and so tonight I climbed the stair a last time and lit her for no ship at all – only for myself, and perhaps for the gulls.\n" +
      "Thirty-one years I have kept this flame. I have counted nine wrecks, and pulled four men living from the water, and I remember each of their faces better than I remember my own.\n" +
      "Whoever finds this: keep something burning. It need not be a lamp.\n" +
      "— E. Tregarthen, Keeper",
  },
  {
    id: "bottle_wish",
    kind: "bottle",
    name: "Poppy's wish",
    desc: "A small pop bottle, corked with more hope than skill; the wish inside is written in orange crayon.",
    valueCents: 350,
    letter:
      "Dear Sea,\n" +
      "My name is Poppy and I am seven and three quarters. Dad says if you post a wish into the sea it comes true slower than a birthday wish but BIGGER.\n" +
      "My wish is that our cat Biscuit comes home. And if he is living with another family now then my wish is that they are kind and give him the crunchy food, not the wet kind, which he only pretends to like to be polite.\n" +
      "If a pirate finds this, the wish still counts. That is the rule.\n" +
      "Love, Poppy (age 7¾)",
  },
  {
    id: "bottle_capsule",
    kind: "bottle",
    name: "Class 4B's capsule",
    desc: "A 1980s lemonade bottle sealed with sticky tape; a message to the year 2000, delivered somewhat late.",
    valueCents: 420,
    letter:
      "TIME CAPSULE – DO NOT OPEN UNTIL THE YEAR 2000!\n" +
      "We are Class 4B of St Merrow's Junior School and today is the 12th of July 1985. Facts for the future: crisps cost 10p. Darren can do a wheelie for a whole minute. Our teacher Mrs Pascoe says that by the year 2000 cars will fly.\n" +
      "So if you are reading this from your flying car, please drive it slowly past Darren's house. He will be about forty, and it will absolutely ruin him.\n" +
      "Signed in best handwriting,\n" +
      "Class 4B (and Susan, who wanted her own line)",
  },
  {
    id: "bottle_apology",
    kind: "bottle",
    name: "The unsent apology",
    desc: "A brown chemist's bottle dripped with candle wax; it carried an apology further than its writer ever managed to.",
    valueCents: 500,
    letter:
      "Frank,\n" +
      "I have started this letter more times than I can count, and burned every one of them, so this time I shall finish it and let the tide decide what I could not.\n" +
      "You were right about the boat. I sold her because I was angry, and I was angry because Father left her to you and not to me, and none of it was worth twenty years of silence between us. She was only planks and paint, Frank. You are my brother.\n" +
      "If this reaches any shore at all, let it be yours.\n" +
      "— Wilf",
  },
  {
    id: "bottle_forecast",
    kind: "bottle",
    name: "The skipper's glass",
    desc: "A pale green flask with a rope collar; a fisherman's weather wisdom, still perfectly reliable.",
    valueCents: 380,
    letter:
      "Notes for whoever fishes this ground after me.\n" +
      "Glass falling fast and the gulls gone inland means it will blow hard from the south-west by morning, whatever the wireless says. Do not trust the calm off the point – she flatters you first, then she takes your gear.\n" +
      "Mackerel came early this year. A seal follows the boat on Tuesdays, regular as rent, and he has earned his fish, so pay him.\n" +
      "And if the glass drops while the cat sits with her back to the fire: stay home.\n" +
      "— D. H., skipper of the Merry Alice",
  },
  {
    id: "bottle_coordinates",
    kind: "bottle",
    name: "The standing appointment",
    desc: "A cobalt blue bottle under a red wax seal; two coordinates and a promise with no expiry date.",
    valueCents: 750,
    letter:
      "If you are not R., kindly put this back in the water. If you are R.:\n" +
      "49° 30′ N, 7° 10′ W. The cove below the coastguard cottages, where the rock makes a chair for two people who sit close, where you laughed at my terrible rowing. The ninth of June, seven o'clock in the evening, nineteen sixty-two.\n" +
      "I will be there on the ninth of June every year for as long as I have legs to climb down with.\n" +
      "You said the sea loses nothing worth keeping. Prove it, and come.\n" +
      "— T.",
  },

  // ------------------------------------------------------------ jewellery --
  {
    id: "jewel_ring",
    kind: "jewellery",
    name: "Gold wedding band",
    desc: "A plain 22-carat band engraved 'A · E · 1911' on the inside; slipped from a cold finger at the tideline.",
    valueCents: 24000,
  },
  {
    id: "jewel_signet",
    kind: "jewellery",
    name: "Onyx signet ring",
    desc: "A gentleman's gold signet with an onyx table, the crest worn to a whisper by three generations of handshakes.",
    valueCents: 31000,
  },
  {
    id: "jewel_pearls",
    kind: "jewellery",
    name: "Pearl necklace",
    desc: "A graduated string of saltwater pearls on silk with a gold clasp; lost overboard from a pleasure steamer, the story goes.",
    valueCents: 78000,
  },
  {
    id: "jewel_bracelet",
    kind: "jewellery",
    name: "Silver curb bracelet",
    desc: "A Victorian curb-link bracelet tarnished storm-grey; the clasp still closes with a good firm click.",
    valueCents: 15500,
  },
  {
    id: "jewel_brooch",
    kind: "jewellery",
    name: "Ship brooch",
    desc: "A gilt brooch in the shape of a full-rigged ship with a garnet riding where the cargo would be; a sweetheart gift from a sailor.",
    valueCents: 12000,
  },
  {
    id: "jewel_watch",
    kind: "jewellery",
    name: "Drowned pocket watch",
    desc: "A corroded silver pocket watch, stopped at 7:38; the sea keeps whatever time it takes.",
    valueCents: 145000,
  },
];

export const COLLECTIBLE_BY_ID: Record<string, CollectibleDef> =
  Object.fromEntries(COLLECTIBLES.map((c) => [c.id, c]));
