import Map "mo:core/Map";

module {
  // Inlined copy of the player record - migrations must be self-contained
  // and may only import from mo:core.
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

  type OldActor = {};

  type NewActor = {
    players : Map.Map<Principal, PlayerInternal>;
  };

  public func migration(_old : OldActor) : NewActor {
    { players = Map.empty<Principal, PlayerInternal>() };
  };
};
