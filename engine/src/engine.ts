import {
  BALANCES, FILLS, ORDERBOOKS, ORDERS,
  type CreateOrderInput, type DepthResponse, type Fill, type OrderBook, type OrderRecord,
} from "./store/exchange-store.js";

const QUOTE = "USDT";

function balances(userId: string) {
  let b = BALANCES.get(userId);
  if (!b) BALANCES.set(userId, (b = { BTC: { available: 10, locked: 0 }, [QUOTE]: { available: 100_000, locked: 0 } }));
  return b;
}

const book = (symbol: string): OrderBook => {
  let b = ORDERBOOKS.get(symbol);
  if (!b) ORDERBOOKS.set(symbol, (b = { bids: new Map(), asks: new Map() }));
  return b;
};

// Move funds between available and locked (positive = lock, negative = release).
function lock(userId: string, asset: string, amount: number) {
  const bal = (balances(userId)[asset] ??= { available: 0, locked: 0 });
  bal.available -= amount;
  bal.locked += amount;
}

// Settle one trade; the buyer's locked quote is at their limit price, refunded down to the fill price.
function settle(buyer: OrderRecord, seller: OrderRecord, symbol: string, price: number, qty: number) {
  const b = balances(buyer.userId), s = balances(seller.userId);
  const base = (x: ReturnType<typeof balances>) => (x[symbol] ??= { available: 0, locked: 0 });
  if (buyer.price !== null) {
    b[QUOTE]!.locked -= buyer.price * qty;
    b[QUOTE]!.available += (buyer.price - price) * qty;
  } else b[QUOTE]!.available -= price * qty;
  base(b).available += qty;
  base(s).locked -= qty;
  s[QUOTE]!.available += price * qty;
}

export function createOrder(i: CreateOrderInput) {
  const { userId, type, side, symbol, price, qty } = i;
  if (!symbol || !(qty > 0)) throw new Error("invalid qty");
  if (type === "limit" && !(price! > 0)) throw new Error("invalid price");
  const bal = balances(userId);
  if (side === "sell") {
    if ((bal[symbol]?.available ?? 0) < qty) throw new Error("insufficient balance");
    lock(userId, symbol, qty);
  } else if (type === "limit") {
    if (bal[QUOTE]!.available < price! * qty) throw new Error("insufficient balance");
    lock(userId, QUOTE, price! * qty);
  }

  const order: OrderRecord = {
    orderId: crypto.randomUUID(), userId, side, type, symbol, qty, filledQty: 0,
    price: type === "limit" ? price : null, status: "open", fills: [], createdAt: Date.now(),
  };
  ORDERS.set(order.orderId, order);

  const ob = book(symbol);
  const opp = side === "buy" ? ob.asks : ob.bids;
  const levels = [...opp.keys()].sort((a, b) => (side === "buy" ? a - b : b - a));

  for (const lvl of levels) {
    if (order.filledQty >= qty) break;
    if (type === "limit" && (side === "buy" ? lvl > price! : lvl < price!)) break;
    const queue = opp.get(lvl)!; // FIFO within a level = time priority
    while (queue.length && order.filledQty < qty) {
      const resting = queue[0]!;
      let q = Math.min(qty - order.filledQty, resting.qty - resting.filledQty);
      if (side === "buy" && type === "market") q = Math.min(q, bal[QUOTE]!.available / lvl);
      if (q <= 0) break;
      const [buyer, seller] = side === "buy" ? [order, resting] : [resting, order];
      const fill: Fill = {
        fillId: crypto.randomUUID(), symbol, price: lvl, qty: q,
        buyOrderId: buyer.orderId, sellOrderId: seller.orderId, createdAt: Date.now(),
      };
      settle(buyer, seller, symbol, lvl, q);
      for (const o of [order, resting]) {
        o.filledQty += q;
        o.fills.push(fill);
        o.status = o.filledQty >= o.qty ? "filled" : "partially_filled";
      }
      FILLS.push(fill);
      if (resting.status === "filled") queue.shift();
    }
    if (!queue.length) opp.delete(lvl);
  }

  if (order.status !== "filled") {
    if (type === "limit") {
      const side_ = side === "buy" ? ob.bids : ob.asks;
      (side_.get(price!) ?? side_.set(price!, []).get(price!)!).push(order);
    } else {
      release(order); // unfilled market remainder is dropped
      if (order.filledQty === 0) order.status = "cancelled";
    }
  }
  return {
    orderId: order.orderId, status: order.status, filledQty: order.filledQty,
    remainingQty: qty - order.filledQty, fills: order.fills,
  };
}

// Unlock whatever is still reserved for the unfilled part of an order.
function release(o: OrderRecord) {
  const rem = o.qty - o.filledQty;
  if (o.side === "sell") lock(o.userId, o.symbol, -rem);
  else if (o.price !== null) lock(o.userId, QUOTE, -o.price * rem);
}

export function cancelOrder(orderId: string, userId?: string) {
  const o = getOrder(orderId, userId);
  if (o.status === "filled") throw new Error("cannot cancel a filled order");
  if (o.status === "cancelled") throw new Error("order is already cancelled");
  const side = o.side === "buy" ? book(o.symbol).bids : book(o.symbol).asks;
  const q = (side.get(o.price!) ?? []).filter((x) => x.orderId !== orderId);
  q.length ? side.set(o.price!, q) : side.delete(o.price!);
  release(o);
  o.status = "cancelled";
  return { orderId, status: o.status };
}

export function getOrder(orderId: string, userId?: string) {
  const o = ORDERS.get(orderId);
  if (!o || (userId && o.userId !== userId)) throw new Error("order not found");
  return o;
}

export const getBalance = (userId: string) => balances(userId);

export function getDepth(symbol: string): DepthResponse {
  const ob = ORDERBOOKS.get(symbol);
  const agg = (m: Map<number, OrderRecord[]> | undefined, dir: 1 | -1) =>
    [...(m ?? [])]
      .map(([price, os]) => ({ price, qty: os.reduce((s, o) => s + o.qty - o.filledQty, 0) }))
      .sort((a, b) => dir * (a.price - b.price));
  return { symbol, bids: agg(ob?.bids, -1), asks: agg(ob?.asks, 1) };
}
