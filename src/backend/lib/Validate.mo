import Array "mo:core/Array";
import Int "mo:core/Int";
import Types "../types";

module {
  // Sanity bounds so a misbehaving client cannot bloat stable memory
  // or poison the leaderboard with absurd values.
  public func saveInput(input : Types.SaveInput) : Bool {
    input.data.size() <= 60_000 and input.level <= 250 and input.xp <= 200_000_000 and input.totalCollected <= 50_000_000 and input.totalDisposed <= 50_000_000 and input.recyclePoints <= 500_000_000;
  };

  func isNameChar(c : Char) : Bool {
    (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or (c >= '0' and c <= '9') or c == ' ' or c == '-' or c == '_' or c == '.' or c == 'ä' or c == 'ö' or c == 'ü' or c == 'Ä' or c == 'Ö' or c == 'Ü' or c == 'ß';
  };

  // Trims and accepts 3..24 characters of letters, digits, space, - _ .
  // Returns null when the name is not usable as a display name.
  public func normalizeName(raw : Text) : ?Text {
    let name = raw.trim(#char ' ');
    let n = name.size();
    if (n < 3 or n > 24) { return null };
    for (c in name.toIter()) {
      if (not isNameChar(c)) { return null };
    };
    ?name;
  };

  // Case-insensitive key used to keep display names unique.
  public func nameKey(name : Text) : Text {
    name.toLower();
  };

  // ---------------- Marketplace ----------------

  // Basis points. Every ratio in the exchange is expressed in these.
  public let bp : Nat = 10_000;

  // Prices are carried in TEN-THOUSANDTHS OF A CENT ("centsE4"), because the
  // cheap bulk commodities land below one cent per unit once the real-world
  // price structure is used. 350 cents/unit == 3_500_000 centsE4.
  public let priceScale : Nat = 10_000;

  // ---------------- Oracle reference prices ----------------
  //
  // The reference ("oracle") price of every material is the REAL secondary
  // commodity price, in USD per kg (per L for the solvent), multiplied by one
  // single scale factor:
  //
  //     SCALE = 2.52     (one in-game dollar buys what ~0.40 real dollars buy)
  //
  // The factor is pinned by PET flake, which the game has always priced at
  // $3.50/unit: 1.39 USD/kg * 2.52 = 3.50 USD/unit. Everything else keeps its
  // real RELATIVE value, so the in-game market has the same shape as the real
  // recovered-materials market. oracleCentsE4 = realUsdPerUnit * 2_520_000.
  //
  // Real 2025/26 source prices (see the frontend types.ts for the same table):
  //
  //   id              real USD/unit  source
  //   glass_cullet    0.079 /kg      businessanalytiq NA cullet index,
  //                                  $78.57/tonne (range -0.02..0.17: NERC
  //                                  Q4-25 notes MRFs often PAY to move glass)
  //   pet_flake       1.39  /kg      ChemAnalyst US r-PET flake, $1,388.67/t
  //                                  Q2-2026 (baled bottles are far cheaper at
  //                                  ~$0.07/kg - the station ships FLAKE)
  //   metal_scrap     0.42  /kg      ScrapMonster shredded scrap $413/t
  //                                  Jan-2026 (floor #1 HMS 0.32, ceiling
  //                                  Zorba nonferrous 2.14)
  //   paper_pulp      0.085 /kg      Secondary Materials Pricing OCC index via
  //                                  Resource Recycling, $77.50/short ton,
  //                                  Jul-2026
  //   wood_chips      0.037 /kg      Ryegate VT delivered biomass invoices,
  //                                  $33.10/green short ton, Jun-25..May-26,
  //                                  ~45 % moisture
  //   aggregate       0.020 /kg      USGS Mineral Commodity Summaries 2026,
  //                                  crushed stone $18.00/short ton
  //   chem_recovered  0.67  /L       derived: ChemAnalyst virgin acetone/IPA
  //                                  Q2-2026 less the 30-50 % reclaimed
  //                                  discount, at 0.785 kg/L. No public index
  //                                  exists for reclaimed solvent - estimate.
  //   rdf_pellets     0.05  /kg      RDF into North American cement kilns,
  //                                  ~$45/short ton. NOTE: in the UK/EU RDF has
  //                                  a NEGATIVE value (a 90-140 GBP/t gate fee
  //                                  the producer pays). A negative price
  //                                  cannot exist in a Nat-priced game, so the
  //                                  positive high-spec SRF price is used.
  //
  // Everything here is fictional in-game money with no real-world value.
  let materials : [(Text, Nat)] = [
    ("glass_cullet", 199_080),
    ("pet_flake", 3_502_800),
    ("metal_scrap", 1_058_400),
    ("paper_pulp", 214_200),
    ("wood_chips", 93_240),
    ("aggregate", 50_400),
    ("chem_recovered", 1_688_400),
    ("rdf_pellets", 126_000),
  ];

  // The oracle table, in table order. Iterated by the exchange endpoints.
  public func oracleTable() : [(Text, Nat)] { materials };

  // Oracle reference price in centsE4 per unit, or null for an unknown id.
  public func oracleCentsE4(material : Text) : ?Nat {
    switch (materials.find(func entry = entry.0 == material)) {
      case (?entry) { ?entry.1 };
      case null { null };
    };
  };

  // What the station's wholesale desk keeps below the oracle. The desk has
  // unlimited liquidity and no price impact, so it is deliberately the worst
  // price in the game - the exchange (0.30 % + impact) beats it on any sane
  // trade size, which is the whole point of having an exchange.
  public let wholesaleSpreadBp : Nat = 1_200;

  // Wholesale price per unit in WHOLE cents (the wallet's granularity), or
  // null for an unknown material id. Floors at 1 cent so nothing is free.
  public func basePriceCents(material : Text) : ?Nat {
    switch (oracleCentsE4(material)) {
      case null { null };
      case (?e4) {
        let cents = (e4 * minus(bp, wholesaleSpreadBp)) / (bp * priceScale);
        ?(if (cents < 1) { 1 } else { cents });
      };
    };
  };

  public func isMaterial(material : Text) : Bool {
    oracleCentsE4(material) != null;
  };

  // The dollar side of the exchange. Not a material id.
  public let usdAsset : Text = "USD";

  public func isAsset(asset : Text) : Bool {
    asset == usdAsset or isMaterial(asset);
  };

  // Order sizes stay well inside a single message: 1..100_000 units.
  public func tradeAmount(amount : Nat) : Bool {
    amount >= 1 and amount <= 100_000;
  };

  // 1 cent .. 10_000 dollars per unit.
  public func unitPriceCents(cents : Nat) : Bool {
    cents >= 1 and cents <= 1_000_000;
  };

  // ---------------- Exchange (virtual AMM) ----------------

  // Fee per leg, burned - it is taken out of the dollar side and simply
  // ceases to exist, so a material<->material swap pays it twice.
  public let swapFeeBp : Nat = 30;

  // Virtual liquidity: every pool is seeded with $20,000 of dollars and the
  // matching amount of material at the oracle price. Depth is constant in
  // DOLLARS, so price impact only depends on the dollar notional of a trade:
  // impact ~= notional / (20_000 + notional). $200 moves the price ~1 %,
  // $2,000 ~9 %, $5,000 ~20 %.
  public let poolDepthCents : Nat = 2_000_000;

  // A single swap may consume at most this share of the reserve it draws
  // from. 2_500 bp = 25 %, which is also a 25 % price impact.
  public let maxDrainBp : Nat = 2_500;

  // Hard floor per reserve: 5 % of the seeded depth. Reaching it takes ten
  // consecutive maximum-size swaps in the same direction; past it the pool
  // rejects with #poolTooThin, so a reserve can never reach zero.
  public let poolFloorBp : Nat = 500;

  // Mean reversion: the reserves are pulled back toward the oracle seed with
  // a half-life of 4 hours (lambda = ln 2 / 4 h = 0.1733 per hour), applied
  // lazily from the pool's stored timestamp. It is evaluated in whole steps of
  // 1/16 half-life (15 minutes) and the timestamp is advanced by exactly the
  // steps consumed, so a busy market still reverts - the remainder is carried,
  // never reset. No floating point is involved anywhere.
  public let poolStepNs : Nat = 900_000_000_000;

  // 256 steps = 16 half-lives = 64 h. Beyond that the pool is at the oracle.
  public let poolMaxSteps : Nat = 256;

  // 2^(-k/16), k = 0..15, in millionths. Sub-step resolution for the decay.
  let decay16 : [Nat] = [
    1_000_000,
    957_603,
    917_004,
    878_126,
    840_896,
    805_245,
    771_105,
    738_413,
    707_107,
    677_128,
    648_420,
    620_929,
    594_604,
    569_394,
    545_254,
    522_137,
  ];

  // How much of the pool's CURRENT deviation survives `steps` reversion steps,
  // in basis points. 10_000 = nothing reverted yet, 0 = back at the oracle.
  public func retentionBp(steps : Nat) : Nat {
    if (steps == 0) { return bp };
    if (steps >= poolMaxSteps) { return 0 };
    let halves = steps / 16;
    let rest = steps % 16;
    (decay16[rest] * bp) / (1_000_000 * (2 ** halves));
  };

  // Recent-price ring buffer: at most 24 samples, at least 5 minutes apart.
  // A sample younger than the spacing is overwritten instead of appended, so
  // a burst of trades cannot flush the window.
  public let trendLength : Nat = 24;
  public let trendSpacingNs : Int = 300_000_000_000;

  // Material side of a swap: 1..100_000 units, same bound as the order book.
  public func swapUnits(units : Nat) : Bool {
    units >= 1 and units <= 100_000;
  };

  // Dollar side of a swap: 1 cent .. $100,000.
  public func swapCents(cents : Nat) : Bool {
    cents >= 1 and cents <= 10_000_000;
  };

  // At most this many open orders per seller, so no single player can fill
  // the order book.
  public let maxOrdersPerSeller : Nat = 30;

  // Newest orders returned by the public order-book query.
  public let maxListedOrders : Nat = 200;

  // Subtraction that cannot trap: evaluated in Int and clamped at zero.
  public func minus(a : Nat, b : Nat) : Nat {
    if (a <= b) { 0 } else { Int.abs(a - b) };
  };
};
