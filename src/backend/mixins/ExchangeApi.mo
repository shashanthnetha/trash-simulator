import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Pool "../lib/Pool";
import Types "../types";
import Validate "../lib/Validate";

// Instant swaps against a virtual constant-product market maker, one pool per
// material, quoted against the in-game dollar. This is the market-order half
// of the exchange; the limit-order book lives in MarketApi and is untouched.
//
// Trust model - identical to the order book, and worth repeating: the dollar
// balances are backend state and authoritative. The materials are client-held
// save-game data, so a swap that spends material relies on the client removing
// it locally, exactly like marketCreate does. The pools are authoritative for
// PRICE only; they hold no inventory and their dollars are minted and burned.
// Everything is fictional in-game money with no real-world value.
//
// Neither marketSwap nor any helper here contains an await, so the balance
// check, the balance write and both pool writes are one atomic message.
mixin (
  players : Map.Map<Principal, Types.PlayerInternal>,
  balances : Map.Map<Principal, Nat>,
  pools : Map.Map<Text, Types.Pool>,
  exchange : { var swaps : Nat; var feeBurnedCents : Nat },
) {

  // Helper names are prefixed so they cannot collide with the other mixins
  // that are included into the same actor.
  func xchgRegistered(caller : Principal) : { #ok; #err : Types.MarketError } {
    if (caller.isAnonymous()) { return #err(#anonymous) };
    switch (players.get(caller)) {
      case (?_) { #ok };
      case null { #err(#notRegistered) };
    };
  };

  func xchgBalance(owner : Principal) : Nat {
    balances.get(owner) ?? 0;
  };

  func xchgDeviationBp(mid : Nat, oracle : Nat) : Int {
    if (oracle == 0) { return 0 };
    ((mid.toInt() - oracle.toInt()) * Validate.bp) / oracle.toInt();
  };

  // The pool of `material` as of `now`: seeded at the oracle when it has never
  // traded, and mean-reverted from its stored timestamp. Pure - a query calls
  // this and throws the result away, an update stores it.
  // Returns the pool, its reserves and the seed reserves it reverts toward.
  func xchgLoad(material : Text, now : Int) : (Types.Pool, Pool.Reserves, Pool.Reserves) {
    let seeded = Pool.seed(Validate.oracleCentsE4(material) ?? 0);
    let p : Types.Pool = switch (pools.get(material)) {
      case null {
        {
          reserveUnits = seeded.units;
          reserveCents = seeded.cents;
          revertedAt = now;
          trend = [];
        };
      };
      case (?stored) {
        let steps = Pool.stepsSince(stored.revertedAt, now);
        if (steps == 0) { stored } else {
          let moved = Pool.revert(
            { units = stored.reserveUnits; cents = stored.reserveCents },
            seeded,
            steps,
          );
          {
            reserveUnits = moved.units;
            reserveCents = moved.cents;
            // Advance by whole steps only: the remainder is carried over, so
            // a constantly traded pool still reverts.
            revertedAt = stored.revertedAt + steps * Validate.poolStepNs;
            trend = stored.trend;
          };
        };
      };
    };
    (p, { units = p.reserveUnits; cents = p.reserveCents }, seeded);
  };

  // Appends a mid-price sample. A sample younger than the minimum spacing
  // replaces the newest one, and the oldest is dropped once the ring is full.
  func xchgPushTrend(trend : [Types.PricePoint], at : Int, midCentsE4 : Nat) : [Types.PricePoint] {
    let n = trend.size();
    let replace = n > 0 and at - trend[n - 1].at < Validate.trendSpacingNs;
    let stop = if (replace) { Validate.minus(n, 1) } else { n };
    let start = if (not replace and n >= Validate.trendLength) {
      Validate.minus(n + 1, Validate.trendLength);
    } else { 0 };
    let out = List.empty<Types.PricePoint>();
    var i = start;
    while (i < stop) {
      out.add(trend[i]);
      i += 1;
    };
    out.add({ at; midCentsE4 });
    out.toArray();
  };

  func xchgCommit(material : Text, p : Types.Pool, now : Int) {
    let mid = Pool.midCentsE4({ units = p.reserveUnits; cents = p.reserveCents });
    pools.add(material, { p with trend = xchgPushTrend(p.trend, now, mid) });
  };

  // Prices both legs and returns everything marketSwap needs to commit.
  // A material -> material swap is routed through USD as two priced legs.
  func xchgQuote(fromAsset : Text, toAsset : Text, amountIn : Nat, now : Int) : Types.MarketResult<Types.SwapPlan> {
    if (fromAsset == toAsset) { return #err(#identicalAssets) };
    if (not Validate.isAsset(fromAsset)) { return #err(#unknownAsset) };
    if (not Validate.isAsset(toAsset)) { return #err(#unknownAsset) };
    let fromUsd = fromAsset == Validate.usdAsset;
    if (fromUsd) {
      if (not Validate.swapCents(amountIn)) { return #err(#invalidAmount) };
    } else if (not Validate.swapUnits(amountIn)) {
      return #err(#invalidAmount);
    };

    // Dollars -> material.
    if (fromUsd) {
      let (p, r, seeded) = xchgLoad(toAsset, now);
      let leg = Pool.buyMaterial(r, amountIn);
      if (leg.amountOut == 0) { return #err(#invalidAmount) };
      if (not Pool.fits(r, leg.after, seeded)) { return #err(#poolTooThin) };
      return #ok({
        quote = {
          fromAsset;
          toAsset;
          amountIn;
          amountOut = leg.amountOut;
          midAmountOut = leg.midOut;
          midCentsE4 = 0;
          midCentsE4To = Pool.midCentsE4(r);
          priceImpactBp = leg.impactBp;
          feeCents = leg.feeCents;
          route = [fromAsset, toAsset];
        };
        fromPool = null;
        toPool = ?({
          p with reserveUnits = leg.after.units;
          reserveCents = leg.after.cents;
        });
        payCents = amountIn;
        receiveCents = 0;
      });
    };

    // Material -> dollars.
    if (toAsset == Validate.usdAsset) {
      let (p, r, seeded) = xchgLoad(fromAsset, now);
      let leg = Pool.sellMaterial(r, amountIn);
      if (leg.amountOut == 0) { return #err(#invalidAmount) };
      if (not Pool.fits(r, leg.after, seeded)) { return #err(#poolTooThin) };
      return #ok({
        quote = {
          fromAsset;
          toAsset;
          amountIn;
          amountOut = leg.amountOut;
          midAmountOut = leg.midOut;
          midCentsE4 = Pool.midCentsE4(r);
          midCentsE4To = 0;
          priceImpactBp = leg.impactBp;
          feeCents = leg.feeCents;
          route = [fromAsset, toAsset];
        };
        fromPool = ?({
          p with reserveUnits = leg.after.units;
          reserveCents = leg.after.cents;
        });
        toPool = null;
        payCents = 0;
        receiveCents = leg.amountOut;
      });
    };

    // Material -> material: sell leg first, the buy leg spends the net
    // proceeds, so both legs are priced and both pay the fee.
    let (pa, ra, sa) = xchgLoad(fromAsset, now);
    let (pb, rb, sb) = xchgLoad(toAsset, now);
    let sell = Pool.sellMaterial(ra, amountIn);
    if (sell.amountOut == 0) { return #err(#invalidAmount) };
    if (not Pool.fits(ra, sell.after, sa)) { return #err(#poolTooThin) };
    let buy = Pool.buyMaterial(rb, sell.amountOut);
    if (buy.amountOut == 0) { return #err(#invalidAmount) };
    if (not Pool.fits(rb, buy.after, sb)) { return #err(#poolTooThin) };
    let midFrom = Pool.midCentsE4(ra);
    let midTo = Pool.midCentsE4(rb);
    #ok({
      quote = {
        fromAsset;
        toAsset;
        amountIn;
        amountOut = buy.amountOut;
        midAmountOut = if (midTo == 0) { 0 } else { (amountIn * midFrom) / midTo };
        midCentsE4 = midFrom;
        midCentsE4To = midTo;
        priceImpactBp = Pool.combineImpactBp(sell.impactBp, buy.impactBp);
        feeCents = sell.feeCents + buy.feeCents;
        route = [fromAsset, Validate.usdAsset, toAsset];
      };
      fromPool = ?({
        pa with reserveUnits = sell.after.units;
        reserveCents = sell.after.cents;
      });
      toPool = ?({
        pb with reserveUnits = buy.after.units;
        reserveCents = buy.after.cents;
      });
      payCents = 0;
      receiveCents = 0;
    });
  };

  // ---------------- Public API ----------------

  // Reference price, current pool price and the recent trend per material,
  // plus the exchange's own parameters so the UI never hardcodes them.
  public query func marketPrices() : async Types.MarketSnapshot {
    let now = Time.now();
    let rows = List.empty<Types.MarketPrice>();
    for ((id, oracle) in Validate.oracleTable().values()) {
      let (p, r, seeded) = xchgLoad(id, now);
      let mid = Pool.midCentsE4(r);
      rows.add({
        material = id;
        oracleCentsE4 = oracle;
        midCentsE4 = mid;
        wholesaleCents = Validate.basePriceCents(id) ?? 0;
        deviationBp = xchgDeviationBp(mid, oracle);
        poolUnits = r.units;
        poolCents = r.cents;
        maxSellUnits = Pool.maxSellUnits(r, seeded);
        maxBuyCents = Pool.maxBuyCents(r, seeded);
        trend = p.trend;
      });
    };
    {
      at = now;
      priceScale = Validate.priceScale;
      feeBp = Validate.swapFeeBp;
      wholesaleSpreadBp = Validate.wholesaleSpreadBp;
      prices = rows.toArray();
      swaps = exchange.swaps;
      feeBurnedCents = exchange.feeBurnedCents;
    };
  };

  // Prices a swap without executing it. `amountIn` is whole cents when
  // fromAsset is "USD", material units otherwise; amountOut follows toAsset.
  // Same code path as marketSwap, so a quote can only differ from a fill by
  // what other players did in between.
  public query func marketQuote(fromAsset : Text, toAsset : Text, amountIn : Nat) : async Types.MarketResult<Types.SwapQuote> {
    switch (xchgQuote(fromAsset, toAsset, amountIn, Time.now())) {
      case (#err(e)) { #err(e) };
      case (#ok(plan)) { #ok(plan.quote) };
    };
  };

  // Executes a swap against the pools. Rejects when the result would be worse
  // than minAmountOut (pass 0 to accept any price). The dollar leg is settled
  // here; a material leg is settled by the client from the returned receipt -
  // see the trust-model note at the top of this file.
  public shared ({ caller }) func marketSwap(
    fromAsset : Text,
    toAsset : Text,
    amountIn : Nat,
    minAmountOut : Nat,
  ) : async Types.MarketResult<Types.SwapReceipt> {
    switch (xchgRegistered(caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok) {};
    };
    let now = Time.now();
    switch (xchgQuote(fromAsset, toAsset, amountIn, now)) {
      case (#err(e)) { #err(e) };
      case (#ok(plan)) {
        let q = plan.quote;
        if (q.amountOut < minAmountOut) { return #err(#slippage) };
        let funds = xchgBalance(caller);
        if (funds < plan.payCents) { return #err(#insufficientFunds) };
        let newBalance = Validate.minus(funds, plan.payCents) + plan.receiveCents;
        balances.add(caller, newBalance);
        var midFrom = 0;
        var midTo = 0;
        switch (plan.fromPool) {
          case (?p) {
            xchgCommit(fromAsset, p, now);
            midFrom := Pool.midCentsE4({
              units = p.reserveUnits;
              cents = p.reserveCents;
            });
          };
          case null {};
        };
        switch (plan.toPool) {
          case (?p) {
            xchgCommit(toAsset, p, now);
            midTo := Pool.midCentsE4({
              units = p.reserveUnits;
              cents = p.reserveCents;
            });
          };
          case null {};
        };
        exchange.swaps += 1;
        exchange.feeBurnedCents += q.feeCents;
        #ok({
          fromAsset;
          toAsset;
          amountIn;
          amountOut = q.amountOut;
          feeCents = q.feeCents;
          priceImpactBp = q.priceImpactBp;
          balanceCents = newBalance;
          midCentsE4 = midFrom;
          midCentsE4To = midTo;
          at = now;
        });
      };
    };
  };
};
