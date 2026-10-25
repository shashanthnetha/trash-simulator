import Map "mo:core/Map";

module {
  // Inlined copies of the stable record types - migrations must be
  // self-contained and may only import from mo:core.
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

  type OldActor = {
    players : Map.Map<Principal, PlayerInternal>;
  };

  type NewActor = {
    players : Map.Map<Principal, PlayerInternal>;
    marketBalances : Map.Map<Principal, Nat>;
    orderBook : Map.Map<Nat, Order>;
    market : { var nextOrderId : Nat };
  };

  // The marketplace starts empty: no dollars in circulation, no open orders.
  // Dollars only ever enter through marketSellWholesale.
  public func migration(old : OldActor) : NewActor {
    {
      players = old.players;
      marketBalances = Map.empty<Principal, Nat>();
      orderBook = Map.empty<Nat, Order>();
      market = { var nextOrderId = 0 };
    };
  };
};
