import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import { cancelOrder, createOrder, getBalance, getDepth, getOrder } from "./engine.js";
import type { CreateOrderInput } from "./store/exchange-store.js";

export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);

function handleEngineRequest({ type, payload: p }: EngineRequest): unknown {
  const userId = p["userId"] as string;
  switch (type) {
    case "create_order": return createOrder(p as unknown as CreateOrderInput);
    case "get_depth": return getDepth(p["symbol"] as string);
    case "get_user_balance": return getBalance(userId);
    case "get_order": return getOrder(p["orderId"] as string, userId);
    case "cancel_order": return cancelOrder(p["orderId"] as string, userId);
    default: throw new Error(`Unknown message type: ${type}`);
  }
}

async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

// ─── MAIN EVENT LOOP ────────────────────────────────────────────────────────

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (;;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = handleEngineRequest(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}
