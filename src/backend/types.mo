module {
  // Internal, mutable per-player record (stable state, lives inside the players map).
  // The presence of an entry IS the profile: a player exists as soon as the
  // display name was registered on first login.
  public type PlayerInternal = {
    var name : Text;
    var xp : Nat;
    var level : Nat;
    var totalCollected : Nat;
    var totalDisposed : Nat;
    var recyclePoints : Nat;
    // Full client-side save game, serialized as JSON by the frontend.
    var data : Text;
    var updatedAt : Int;
  };

  // Shared types for the API boundary (immutable, serializable).
  // The display name is NOT part of the save: it is fixed at registration.
  public type SaveInput = {
    xp : Nat;
    level : Nat;
    totalCollected : Nat;
    totalDisposed : Nat;
    recyclePoints : Nat;
    data : Text;
  };

  public type SaveOutput = {
    name : Text;
    xp : Nat;
    level : Nat;
    totalCollected : Nat;
    totalDisposed : Nat;
    recyclePoints : Nat;
    data : Text;
    updatedAt : Int;
  };

  // What the client needs right after login to decide: register or play.
  public type ProfileOutput = {
    name : Text;
    xp : Nat;
    level : Nat;
    totalCollected : Nat;
    totalDisposed : Nat;
    recyclePoints : Nat;
    hasSave : Bool;
    updatedAt : Int;
  };

  public type RegisterResult = {
    #ok : ProfileOutput;
    #alreadyRegistered : ProfileOutput;
    #nameTaken;
    #invalidName;
    #anonymous;
  };

  public type LeaderboardEntry = {
    name : Text;
    xp : Nat;
    level : Nat;
    totalDisposed : Nat;
  };

  public type GlobalStats = {
    players : Nat;
    totalCollected : Nat;
    totalDisposed : Nat;
  };

  // ---------------- Marketplace ----------------
  // Trust model: the recycled materials themselves are client-held, exactly
  // like the rest of the save game. Only the dollar balances and the open
  // orders are backend-authoritative, so escrow happens on the client:
  // the seller removes the goods locally when marketCreate succeeds and
  // restocks them when marketCancel returns the order.

  // An open sell order. Immutable - a partial buy replaces the record.
  public type Order = {
    id : Nat;
    seller : Principal;
    sellerName : Text;
    material : Text;
    // Units still on offer.
    amount : Nat;
    // Asking price per unit in US cents.
    pricePerUnitCents : Nat;
    createdAt : Int;
  };

  // What a completed buy did: the order as it looks afterwards (amount 0 and
  // removed from the book when the buy filled it) plus what the buyer paid.
  public type Purchase = {
    order : Order;
    costCents : Nat;
  };

  public type MarketError = {
    // Caller is the anonymous principal.
    #anonymous;
    // Signed in, but has not registered a display name yet.
    #notRegistered;
    #unknownMaterial;
    #invalidAmount;
    #invalidPrice;
    #tooManyOrders;
    #notFound;
    #notSeller;
    #ownOrder;
    #insufficientFunds;
    // ---- exchange ----
    // Asset id is neither "USD" nor a known material.
    #unknownAsset;
    // from and to are the same asset.
    #identicalAssets;
    // The swap would have returned less than minAmountOut.
    #slippage;
    // The swap would push a pool past its drain cap or below its floor.
    #poolTooThin;
  };

  // Structurally identical to Result.Result<T, MarketError>; inlined so the
  // shared type stays readable in the generated Candid.
  public type MarketResult<T> = {
    #ok : T;
    #err : MarketError;
  };

  // ---------------- Exchange ----------------
  //
  // Next to the limit-order book there is a virtual constant-product market
  // maker per material, quoted against the in-game dollar. It holds no real
  // inventory: the reserves are a price curve, seeded at the oracle price and
  // pulled back toward it over time. Swaps are market orders against that
  // curve, limit orders stay in the book above.
  //
  // Prices are in centsE4 = ten-thousandths of a cent (350 cents = 3_500_000),
  // because the cheap bulk materials are worth well under one cent per unit.
  // Amounts are whole material units, or whole cents when the asset is "USD".
  //
  // Trust model: identical to the order book. Dollars are backend state, the
  // materials are client-held save-game data. A swap that consumes material
  // relies on the client removing it locally, exactly like marketCreate does.
  // The pool is authoritative for PRICE, never for inventory.

  // One sample of a pool's mid price, for the UI's sparkline.
  public type PricePoint = {
    at : Int;
    midCentsE4 : Nat;
  };

  // Stable per-material pool state. Immutable, so a write replaces the entry.
  // A material with no entry yet behaves exactly like a freshly seeded pool.
  public type Pool = {
    reserveUnits : Nat;
    reserveCents : Nat;
    // Up to which point in time the mean reversion has been applied. Advanced
    // by whole steps only, so the unconsumed remainder is never lost.
    revertedAt : Int;
    // Oldest first, at most Validate.trendLength entries.
    trend : [PricePoint];
  };

  public type MarketPrice = {
    material : Text;
    // The real-world-calibrated reference price.
    oracleCentsE4 : Nat;
    // What the pool currently trades at.
    midCentsE4 : Nat;
    // What the station's wholesale desk pays, in whole cents.
    wholesaleCents : Nat;
    // (mid - oracle) / oracle in basis points; negative = below the oracle.
    deviationBp : Int;
    poolUnits : Nat;
    poolCents : Nat;
    // Largest single swap the pool accepts right now, per direction.
    maxSellUnits : Nat;
    maxBuyCents : Nat;
    trend : [PricePoint];
  };

  public type MarketSnapshot = {
    at : Int;
    // Ten-thousandths of a cent per cent; divide prices by this for cents.
    priceScale : Nat;
    // Fee per leg in basis points, burned.
    feeBp : Nat;
    // How far the wholesale desk sits below the oracle, in basis points.
    wholesaleSpreadBp : Nat;
    prices : [MarketPrice];
    // Lifetime counters since the exchange went live.
    swaps : Nat;
    feeBurnedCents : Nat;
  };

  public type SwapQuote = {
    fromAsset : Text;
    toAsset : Text;
    amountIn : Nat;
    amountOut : Nat;
    // What amountOut would be at the mid price, with neither impact nor fee.
    midAmountOut : Nat;
    // Mid price of the material being sold / bought, 0 when that side is USD.
    midCentsE4 : Nat;
    midCentsE4To : Nat;
    // Curve impact only; the fee is reported separately.
    priceImpactBp : Nat;
    feeCents : Nat;
    // ["USD", material] / [material, "USD"] / [material, "USD", material].
    route : [Text];
  };

  public type SwapReceipt = {
    fromAsset : Text;
    toAsset : Text;
    // Units of fromAsset the client must REMOVE from its local stock (skip
    // when fromAsset is "USD" - that leg was settled from the wallet).
    amountIn : Nat;
    // Units of toAsset the client must ADD (skip when toAsset is "USD").
    amountOut : Nat;
    feeCents : Nat;
    priceImpactBp : Nat;
    // The caller's wallet after the swap, in cents.
    balanceCents : Nat;
    // Pool mids AFTER the swap, so the UI can update without a refetch.
    midCentsE4 : Nat;
    midCentsE4To : Nat;
    at : Int;
  };

  // Internal: a priced swap that is ready to commit. Not part of the API.
  public type SwapPlan = {
    quote : SwapQuote;
    fromPool : ?Pool;
    toPool : ?Pool;
    // Cents to take from / give to the caller's wallet.
    payCents : Nat;
    receiveCents : Nat;
  };
};
