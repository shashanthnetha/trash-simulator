import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Time "mo:core/Time";
import Types "../types";
import Validate "../lib/Validate";

// Open player-to-player marketplace for recycled raw materials, priced in
// US dollars (stored as integer cents).
//
// Trust model: the materials are client-held like the rest of the save game,
// so the client removes the goods when a sell order is created and restocks
// them when it is cancelled. Dollars and orders live here and are the
// authoritative record. Every update rejects anonymous callers and requires a
// registered profile - the players map supplies the seller's display name.
mixin (
  players : Map.Map<Principal, Types.PlayerInternal>,
  balances : Map.Map<Principal, Nat>,
  orderBook : Map.Map<Nat, Types.Order>,
  market : { var nextOrderId : Nat },
) {

  // Either the caller's profile, or the reason the call must be rejected.
  func profileOf(caller : Principal) : {
    #ok : Types.PlayerInternal;
    #err : Types.MarketError;
  } {
    if (caller.isAnonymous()) { return #err(#anonymous) };
    switch (players.get(caller)) {
      case (?p) { #ok(p) };
      case null { #err(#notRegistered) };
    };
  };

  func balanceOf(owner : Principal) : Nat {
    balances.get(owner) ?? 0;
  };

  func credit(owner : Principal, cents : Nat) {
    balances.add(owner, balanceOf(owner) + cents);
  };

  // Stops counting once the cap is reached instead of scanning the whole book.
  func sellerAtLimit(seller : Principal) : Bool {
    var open = 0;
    for ((_, o) in orderBook.entries()) {
      if (o.seller.equal(seller)) {
        open += 1;
        if (open >= Validate.maxOrdersPerSeller) { return true };
      };
    };
    false;
  };

  // ---------------- Wallet ----------------

  // The caller's wallet in US cents; zero for an identity that never traded.
  public shared query ({ caller }) func marketBalance() : async Nat {
    balanceOf(caller);
  };

  // ---------------- Order book ----------------

  // All open orders, newest first, capped at Validate.maxListedOrders.
  // Ids grow monotonically and the map is keyed by id, so walking the B-tree
  // backwards yields newest first and stops after the cap - no sort, and no
  // iteration beyond the returned page.
  public query func marketOrders() : async [Types.Order] {
    let out = List.empty<Types.Order>();
    var taken = 0;
    for ((_, o) in orderBook.reverseEntries()) {
      if (taken >= Validate.maxListedOrders) { break };
      out.add(o);
      taken += 1;
    };
    out.toArray();
  };

  // Lists materials for sale. The client deducts the goods locally once this
  // returns #ok - see the trust-model note above.
  public shared ({ caller }) func marketCreate(
    material : Text,
    amount : Nat,
    pricePerUnitCents : Nat,
  ) : async Types.MarketResult<Types.Order> {
    switch (profileOf(caller)) {
      case (#err(e)) { #err(e) };
      case (#ok(p)) {
        if (not Validate.isMaterial(material)) { return #err(#unknownMaterial) };
        if (not Validate.tradeAmount(amount)) { return #err(#invalidAmount) };
        if (not Validate.unitPriceCents(pricePerUnitCents)) {
          return #err(#invalidPrice);
        };
        if (sellerAtLimit(caller)) { return #err(#tooManyOrders) };
        let id = market.nextOrderId;
        market.nextOrderId += 1;
        let order : Types.Order = {
          id;
          seller = caller;
          sellerName = p.name;
          material;
          amount;
          pricePerUnitCents;
          createdAt = Time.now();
        };
        orderBook.add(id, order);
        #ok(order);
      };
    };
  };

  // Withdraws an own order. The returned record tells the client how much of
  // the listed material to put back into the player's stock.
  public shared ({ caller }) func marketCancel(orderId : Nat) : async Types.MarketResult<Types.Order> {
    switch (profileOf(caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(_)) {};
    };
    switch (orderBook.get(orderId)) {
      case null { #err(#notFound) };
      case (?o) {
        if (not o.seller.equal(caller)) { return #err(#notSeller) };
        orderBook.remove(orderId);
        #ok(o);
      };
    };
  };

  // Buys up to the listed amount. There is no await in this function, so the
  // balance check and both balance writes are one atomic message - no other
  // call can interleave between them.
  public shared ({ caller }) func marketBuy(orderId : Nat, amount : Nat) : async Types.MarketResult<Types.Purchase> {
    switch (profileOf(caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(_)) {};
    };
    if (not Validate.tradeAmount(amount)) { return #err(#invalidAmount) };
    switch (orderBook.get(orderId)) {
      case null { #err(#notFound) };
      case (?o) {
        if (o.seller.equal(caller)) { return #err(#ownOrder) };
        if (amount > o.amount) { return #err(#invalidAmount) };
        let costCents = amount * o.pricePerUnitCents;
        let funds = balanceOf(caller);
        if (funds < costCents) { return #err(#insufficientFunds) };
        balances.add(caller, Validate.minus(funds, costCents));
        credit(o.seller, costCents);
        let remaining = Validate.minus(o.amount, amount);
        let updated = { o with amount = remaining };
        if (remaining == 0) {
          orderBook.remove(orderId);
        } else {
          orderBook.add(orderId, updated);
        };
        #ok({ order = updated; costCents });
      };
    };
  };

  // The system buyer: sells material at the fixed wholesale price. This is the
  // only way dollars enter the economy. Returns the new balance in cents.
  public shared ({ caller }) func marketSellWholesale(material : Text, amount : Nat) : async Types.MarketResult<Nat> {
    switch (profileOf(caller)) {
      case (#err(e)) { return #err(e) };
      case (#ok(_)) {};
    };
    if (not Validate.tradeAmount(amount)) { return #err(#invalidAmount) };
    switch (Validate.basePriceCents(material)) {
      case null { #err(#unknownMaterial) };
      case (?price) {
        let total = balanceOf(caller) + amount * price;
        balances.add(caller, total);
        #ok(total);
      };
    };
  };
};
