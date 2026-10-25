import Map "mo:core/Map";
import MixinViews "mo:caffeineai-data-viewer/MixinViews";
import Types "types";
import ExchangeApi "mixins/ExchangeApi";
import GameApi "mixins/GameApi";
import MarketApi "mixins/MarketApi";

actor {
  include MixinViews();

  // Stable state - initial values come from the migration chain.
  let players : Map.Map<Principal, Types.PlayerInternal>;

  // Marketplace: player wallets in US cents, the open order book and the
  // order id counter (wrapped in a record so the mixin can mutate it).
  let marketBalances : Map.Map<Principal, Nat>;
  let orderBook : Map.Map<Nat, Types.Order>;
  let market : { var nextOrderId : Nat };

  // Exchange: one virtual market-maker pool per material plus the lifetime
  // swap and burn counters. An absent pool reads as "sitting at the oracle".
  let pools : Map.Map<Text, Types.Pool>;
  let exchange : { var swaps : Nat; var feeBurnedCents : Nat };

  include GameApi(players);
  include MarketApi(players, marketBalances, orderBook, market);
  include ExchangeApi(players, marketBalances, pools, exchange);
};
