import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Time "mo:core/Time";
import Types "../types";
import Validate "../lib/Validate";

mixin (players : Map.Map<Principal, Types.PlayerInternal>) {

  func toOutput(p : Types.PlayerInternal) : Types.SaveOutput {
    {
      name = p.name;
      xp = p.xp;
      level = p.level;
      totalCollected = p.totalCollected;
      totalDisposed = p.totalDisposed;
      recyclePoints = p.recyclePoints;
      data = p.data;
      updatedAt = p.updatedAt;
    };
  };

  func toProfile(p : Types.PlayerInternal) : Types.ProfileOutput {
    {
      name = p.name;
      xp = p.xp;
      level = p.level;
      totalCollected = p.totalCollected;
      totalDisposed = p.totalDisposed;
      recyclePoints = p.recyclePoints;
      hasSave = p.data.size() > 0;
      updatedAt = p.updatedAt;
    };
  };

  func nameIsFree(key : Text) : Bool {
    for ((_, p) in players.entries()) {
      if (Validate.nameKey(p.name) == key) { return false };
    };
    true;
  };

  // ---------------- Profile ----------------

  // The player's profile, or null when this identity has not registered yet.
  public shared query ({ caller }) func getProfile() : async ?Types.ProfileOutput {
    switch (players.get(caller)) {
      case (?p) { ?toProfile(p) };
      case null { null };
    };
  };

  // Checked while the player types, so the form can react before submitting.
  public query func isNameAvailable(rawName : Text) : async Bool {
    switch (Validate.normalizeName(rawName)) {
      case null { false };
      case (?name) { nameIsFree(Validate.nameKey(name)) };
    };
  };

  // One-time registration on first login. The display name is fixed afterwards.
  public shared ({ caller }) func registerProfile(rawName : Text) : async Types.RegisterResult {
    if (caller.isAnonymous()) { return #anonymous };
    switch (players.get(caller)) {
      case (?p) { return #alreadyRegistered(toProfile(p)) };
      case null {};
    };
    switch (Validate.normalizeName(rawName)) {
      case null { #invalidName };
      case (?name) {
        if (not nameIsFree(Validate.nameKey(name))) { return #nameTaken };
        let fresh : Types.PlayerInternal = {
          var name = name;
          var xp = 0;
          var level = 1;
          var totalCollected = 0;
          var totalDisposed = 0;
          var recyclePoints = 0;
          var data = "";
          var updatedAt = Time.now();
        };
        players.add(caller, fresh);
        #ok(toProfile(fresh));
      };
    };
  };

  // ---------------- Save game ----------------

  // Stores the caller's progress. Requires a registered profile; there is no
  // guest mode and no local save.
  public shared ({ caller }) func saveGame(input : Types.SaveInput) : async Bool {
    if (caller.isAnonymous()) { return false };
    if (not Validate.saveInput(input)) { return false };
    switch (players.get(caller)) {
      case (?p) {
        p.xp := input.xp;
        p.level := input.level;
        p.totalCollected := input.totalCollected;
        p.totalDisposed := input.totalDisposed;
        p.recyclePoints := input.recyclePoints;
        p.data := input.data;
        p.updatedAt := Time.now();
        true;
      };
      case null { false };
    };
  };

  public shared query ({ caller }) func loadGame() : async ?Types.SaveOutput {
    switch (players.get(caller)) {
      case (?p) { ?toOutput(p) };
      case null { null };
    };
  };

  // Wipes the progress but keeps the registered display name.
  public shared ({ caller }) func resetProgress() : async Bool {
    switch (players.get(caller)) {
      case (?p) {
        p.xp := 0;
        p.level := 1;
        p.totalCollected := 0;
        p.totalDisposed := 0;
        p.recyclePoints := 0;
        p.data := "";
        p.updatedAt := Time.now();
        true;
      };
      case null { false };
    };
  };

  // Removes profile and progress entirely; the name becomes available again.
  public shared ({ caller }) func deleteSave() : async Bool {
    switch (players.get(caller)) {
      case (?_) {
        players.remove(caller);
        true;
      };
      case null { false };
    };
  };

  // ---------------- Public boards ----------------

  public query func getLeaderboard(maxEntries : Nat) : async [Types.LeaderboardEntry] {
    let rows = List.empty<Types.LeaderboardEntry>();
    for ((_, p) in players.entries()) {
      rows.add({
        name = p.name;
        xp = p.xp;
        level = p.level;
        totalDisposed = p.totalDisposed;
      });
    };
    let sorted = rows.toArray().sort(
      func(a : Types.LeaderboardEntry, b : Types.LeaderboardEntry) : {
        #less;
        #equal;
        #greater;
      } {
        Nat.compare(b.xp, a.xp);
      }
    );
    let cap = if (maxEntries > 100) { 100 } else { maxEntries };
    let out = List.empty<Types.LeaderboardEntry>();
    var taken = 0;
    for (row in sorted.values()) {
      if (taken >= cap) { break };
      out.add(row);
      taken += 1;
    };
    out.toArray();
  };

  public query func getGlobalStats() : async Types.GlobalStats {
    var collected = 0;
    var disposed = 0;
    for ((_, p) in players.entries()) {
      collected += p.totalCollected;
      disposed += p.totalDisposed;
    };
    {
      players = players.size();
      totalCollected = collected;
      totalDisposed = disposed;
    };
  };
};
