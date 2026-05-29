import { BALANCES, ORDERBOOKS } from './exchange-store.ts';
import type { OrderBook } from './exchange-store.ts';

// All the types stay exactly as given in exchange-store.ts
// Add these helpers and functions below the existing exports

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Called every time a userId appears — gives them starting funds if new
export function ensureUserBalance(userId: string): void {
  if (!BALANCES.has(userId)) {
    BALANCES.set(userId, {
      BTC:  { available: 10,      locked: 0 },
      USDT: { available: 100_000, locked: 0 },
    });
  }
}

// Called every time a symbol is used — creates empty order book if new
export function ensureOrderBook(symbol: string): OrderBook {
  if (!ORDERBOOKS.has(symbol)) {
    ORDERBOOKS.set(symbol, { bids: new Map(), asks: new Map() });
  }
  return ORDERBOOKS.get(symbol)!;
}