import Int "mo:core/Int";
import Validate "Validate";

// Constant-product market maker for one material, quoted against the in-game
// dollar. Pure integer arithmetic, no state, no floating point: every function
// here takes the reserves and returns new ones, so the mixin above can run the
// exact same code in a query (discarding the result) and in an update
// (storing it).
//
// The reserves are VIRTUAL. They are a price curve, not an inventory: the
// dollars a pool pays out are minted and the ones it takes in are destroyed,
// the same way the wholesale desk mints dollars today.
module {
  // Immutable view of a pool's two reserves.
  public type Reserves = {
    // Material units.
    units : Nat;
    // Whole cents.
    cents : Nat;
  };

  // The outcome of one leg of a swap.
  public type Leg = {
    // Net output, in the unit of the leg's target asset.
    amountOut : Nat;
    // Output at the mid price: no curve impact, no fee. The UI's reference.
    midOut : Nat;
    // Fee in cents. Burned - it goes neither to the pool nor to a treasury.
    feeCents : Nat;
    // Curve impact in basis points, fee excluded.
    impactBp : Nat;
    after : Reserves;
  };

  func empty(r : Reserves, fee : Nat) : Leg {
    { amountOut = 0; midOut = 0; feeCents = fee; impactBp = 0; after = r };
  };

  // ---------------- seeding ----------------

  // Reserves of a fresh pool: poolDepthCents of dollars and the amount of
  // material that is worth exactly the same at the oracle price.
  public func seed(oracleCentsE4 : Nat) : Reserves {
    if (oracleCentsE4 == 0) {
      return { units = 1; cents = Validate.poolDepthCents };
    };
    // Rounded to nearest, so the seeded mid sits within a fraction of a basis
    // point of the oracle instead of always a touch above it.
    let units = (Validate.poolDepthCents * Validate.priceScale + oracleCentsE4 / 2) / oracleCentsE4;
    {
      units = if (units < 1) { 1 } else { units };
      cents = Validate.poolDepthCents;
    };
  };

  // Mid price in centsE4 per unit.
  public func midCentsE4(r : Reserves) : Nat {
    if (r.units == 0) { 0 } else { (r.cents * Validate.priceScale) / r.units };
  };

  // ---------------- mean reversion ----------------

  // Whole reversion steps that elapsed since `from`. The caller advances the
  // stored timestamp by exactly this many steps.
  public func stepsSince(from : Int, now : Int) : Nat {
    if (now <= from) { return 0 };
    Int.abs(now - from) / Validate.poolStepNs;
  };

  // Pulls both reserves back toward the seed with the documented half-life.
  // Blending numerator and denominator with the same weights moves the mid
  // monotonically from its current value toward the oracle (weighted-mediant
  // property) and restores the pool's depth at the same time, so a drained
  // pool heals instead of staying thin forever.
  public func revert(r : Reserves, s : Reserves, steps : Nat) : Reserves {
    if (steps == 0) { return r };
    let keep = Validate.retentionBp(steps);
    if (keep == 0) { return s };
    let pull = Validate.minus(Validate.bp, keep);
    {
      units = (r.units * keep + s.units * pull) / Validate.bp;
      cents = (r.cents * keep + s.cents * pull) / Validate.bp;
    };
  };

  // ---------------- legs ----------------

  // Material -> dollars. `amountIn` is material units, the output is cents.
  public func sellMaterial(r : Reserves, amountIn : Nat) : Leg {
    if (amountIn == 0 or r.units == 0 or r.cents == 0) { return empty(r, 0) };
    let denom = r.units + amountIn;
    // Strictly less than r.cents, so the reserve can never reach zero.
    let gross = (r.cents * amountIn) / denom;
    let fee = (gross * Validate.swapFeeBp) / Validate.bp;
    {
      amountOut = Validate.minus(gross, fee);
      midOut = (r.cents * amountIn) / r.units;
      feeCents = fee;
      impactBp = (amountIn * Validate.bp) / denom;
      after = { units = denom; cents = Validate.minus(r.cents, gross) };
    };
  };

  // Dollars -> material. `amountInCents` is whole cents, the output is units.
  // The fee is taken off the input first and never enters the pool.
  public func buyMaterial(r : Reserves, amountInCents : Nat) : Leg {
    let fee = (amountInCents * Validate.swapFeeBp) / Validate.bp;
    let eff = Validate.minus(amountInCents, fee);
    if (eff == 0 or r.units == 0 or r.cents == 0) { return empty(r, fee) };
    let denom = r.cents + eff;
    let out = (r.units * eff) / denom;
    {
      amountOut = out;
      midOut = (r.units * amountInCents) / r.cents;
      feeCents = fee;
      impactBp = (eff * Validate.bp) / denom;
      after = { units = Validate.minus(r.units, out); cents = denom };
    };
  };

  // Two legs in a row lose (1 - i1)(1 - i2) of the mid value.
  public func combineImpactBp(a : Nat, b : Nat) : Nat {
    let ka = Validate.minus(Validate.bp, a);
    let kb = Validate.minus(Validate.bp, b);
    Validate.minus(Validate.bp, (ka * kb) / Validate.bp);
  };

  // ---------------- bounds ----------------

  // Lowest a reserve may fall to: the hard floor, or the per-swap drain cap,
  // whichever binds first.
  func limit(before : Nat, seeded : Nat) : Nat {
    let floor = (seeded * Validate.poolFloorBp) / Validate.bp;
    let capped = (before * Validate.minus(Validate.bp, Validate.maxDrainBp)) / Validate.bp;
    if (floor > capped) { floor } else { capped };
  };

  // Whether a leg may be executed: neither reserve may drop below its limit.
  // Only the shrinking side can fail, the growing one passes trivially.
  public func fits(before : Reserves, after : Reserves, s : Reserves) : Bool {
    after.units >= limit(before.units, s.units) and after.cents >= limit(before.cents, s.cents);
  };

  // Largest amount of material the pool takes in one swap. Derived from the
  // cent reserve it has to pay out of: gross = cents - limit, and
  // gross = cents * a / (units + a)  =>  a = gross * units / (cents - gross).
  public func maxSellUnits(r : Reserves, s : Reserves) : Nat {
    if (r.units == 0 or r.cents == 0) { return 0 };
    let low = limit(r.cents, s.cents);
    if (r.cents <= low) { return 0 };
    let gross = Validate.minus(r.cents, low);
    let rest = Validate.minus(r.cents, gross);
    if (rest == 0) { return 0 };
    let units = (gross * r.units) / rest;
    if (units > 100_000) { 100_000 } else { units };
  };

  // Largest number of cents the pool takes in one swap. Reported on the
  // post-fee amount, which makes it slightly conservative and therefore safe.
  public func maxBuyCents(r : Reserves, s : Reserves) : Nat {
    if (r.units == 0 or r.cents == 0) { return 0 };
    let low = limit(r.units, s.units);
    if (r.units <= low) { return 0 };
    let out = Validate.minus(r.units, low);
    let rest = Validate.minus(r.units, out);
    if (rest == 0) { return 0 };
    let cents = (out * r.cents) / rest;
    if (cents > 10_000_000) { 10_000_000 } else { cents };
  };
};
