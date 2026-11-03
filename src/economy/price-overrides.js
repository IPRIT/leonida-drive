// Balance decisions owned by the economy (docs/ECONOMY.md → Balance). tools/economy/build-prices.mjs applies them over
// the catalog price; catalog owners should mirror them. `pending`: announced by a catalog owner but not in the catalog
// yet — priced now so the server and the shop already know it.
export const PRICE_OVERRIDES = Object.freeze({
  // A's tank (category 'military'): ~10 days × 1.7 h of play for a skilled player (simulate.mjs --ladder sports,tank)
  tank: { price: 1500000, category: 'military', kind: 'tank', pending: true },
});
