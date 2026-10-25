import Map "mo:core/Map";

module {
  // Inlined copies of the stable record types - migrations must be
  // self-contained and may only import from mo:core.
  //
  // This file exists because 20260830_120000 was already APPLIED on the live
  // canister (the marketplace deploy) before the exchange work landed. An
  // applied migration is tracked by module name and never re-executed, so the
  // exchange state has to arrive in a NEW chain entry - editing the applied
  // file would (and did) leave `pools` uninitialized and trap the upgrade
  // with IC0503.
  type PlayerInternal = {
    var name : Text;
    var xp : Nat;
    var level : Nat;
    var totalCollected : Nat;
    var totalDisposed : Nat;
    var recyclePoints : Nat;
    var data : Text;
    var updatedAt : Int;
  };

  type Order = {
    id : Nat;
    seller : Principal;
    sellerName : Text;
    material : Text;
    amount : Nat;
    pricePerUnitCents : Nat;
    createdAt : Int;
  };

  type PricePoint = {
    at : Int;
    midCentsE4 : Nat;
  };

  type Pool = {
    reserveUnits : Nat;
    reserveCents : Nat;
    revertedAt : Int;
    trend : [PricePoint];
  };

  // = the NewActor of 20260830_120000 (the state as deployed).
  type OldActor = {
    players : Map.Map<Principal, PlayerInternal>;
    marketBalances : Map.Map<Principal, Nat>;
    orderBook : Map.Map<Nat, Order>;
    market : { var nextOrderId : Nat };
  };

  type NewActor = {
    players : Map.Map<Principal, PlayerInternal>;
    marketBalances : Map.Map<Principal, Nat>;
    orderBook : Map.Map<Nat, Order>;
    market : { var nextOrderId : Nat };
    pools : Map.Map<Text, Pool>;
    exchange : { var swaps : Nat; var feeBurnedCents : Nat };
  };

  // The pool map starts empty on purpose. A material without an entry is read
  // as a pool that sits exactly at its oracle price, so the seeding rule lives
  // in the application code next to the price table instead of being frozen
  // into this file - which also means adding a material later needs no
  // migration at all.
  public func migration(old : OldActor) : NewActor {
    {
      players = old.players;
      marketBalances = old.marketBalances;
      orderBook = old.orderBook;
      market = old.market;
      pools = Map.empty<Text, Pool>();
      exchange = { var swaps = 0; var feeBurnedCents = 0 };
    };
  };
};
