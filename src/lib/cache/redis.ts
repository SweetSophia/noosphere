import Redis from "ioredis";

let redisClient: Redis | null = null;
let isConfigured = true;
let nextConnectAttemptAt = 0;
let redisConnectPromise: Promise<void> | null = null;

const REDIS_RECONNECT_COOLDOWN_MS = 5000;
const TERMINAL_REDIS_STATUSES = new Set(["close", "end"]);
const disconnectingRedisClients = new WeakSet<object>();

/**
 * Start disconnecting a client at most once. ioredis does not transition
 * `status` synchronously, so status checks alone cannot deduplicate concurrent
 * timeout and recovery paths that share the singleton.
 */
export function disconnectRedisClientOnce(
  client: Pick<Redis, "disconnect">
): void {
  const identity = client as object;
  if (disconnectingRedisClients.has(identity)) return;

  disconnectingRedisClients.add(identity);
  client.disconnect();
}

/**
 * Disconnect a timed-out client and synchronously remove it from the shared
 * singleton. ioredis updates `status` only after the socket close event, so
 * waiting for a terminal status could hand the same wedged client to another
 * request. The cooldown also prevents a reconnect storm during an outage.
 */
export function invalidateRedisClient(
  client: Pick<Redis, "disconnect">
): void {
  if (redisClient === client) {
    redisClient = null;
    redisConnectPromise = null;
    nextConnectAttemptAt = Date.now() + REDIS_RECONNECT_COOLDOWN_MS;
  }
  try {
    disconnectRedisClientOnce(client);
  } catch (error) {
    // The singleton was already invalidated above. Preserve the original
    // command-timeout error rather than replacing it with cleanup failure.
    console.error("Redis disconnect error:", error);
  }
}

function resetRedisClient(client: Redis | null = redisClient): void {
  if (client && !TERMINAL_REDIS_STATUSES.has(client.status)) {
    disconnectRedisClientOnce(client);
  }
  redisClient = null;
  redisConnectPromise = null;
}

/**
 * Returns the Redis singleton, or null when REDIS_URL is not configured.
 * Intentionally returns null (instead of throwing) so callers can fail open
 * and skip caching without noisy error logs on every request.
 */
export function getRedisClient(): Redis | null {
  if (!isConfigured) {
    return null;
  }
  if (Date.now() < nextConnectAttemptAt) {
    return null;
  }
  if (redisClient) {
    if (TERMINAL_REDIS_STATUSES.has(redisClient.status)) {
      resetRedisClient(redisClient);
    } else {
      return redisClient;
    }
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    isConfigured = false;
    return null;
  }

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 1) {
        return null;
      }
      return 500;
    },
    lazyConnect: true,
  });

  client.on("error", (err) => {
    // Only log non-connection errors (connection errors are expected when Redis is down)
    if (
      !(err instanceof Error) ||
      (!err.message.includes("ECONNREFUSED") &&
        !err.message.includes("Connection is closed"))
    ) {
      console.error("Redis client error:", err);
    }
  });

  redisClient = client;
  return redisClient;
}

export async function getReadyRedisClient(): Promise<Redis | null> {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  if (client.status === "ready") {
    return client;
  }

  if (client.status !== "wait") {
    return null;
  }

  try {
    redisConnectPromise ??= client.connect().finally(() => {
      redisConnectPromise = null;
    });
    await redisConnectPromise;
    return (client.status as string) === "ready" ? client : null;
  } catch (error) {
    console.error("Redis connection error:", error);
    nextConnectAttemptAt = Date.now() + REDIS_RECONNECT_COOLDOWN_MS;
    resetRedisClient(client);
    return null;
  }
}

export async function closeRedisClient(): Promise<void> {
  resetRedisClient();
  isConfigured = true;
  nextConnectAttemptAt = 0;
}

export const _redisTestHooks = {
  setClientForTesting(client: Redis | null) {
    redisClient = client;
    redisConnectPromise = null;
    isConfigured = true;
    nextConnectAttemptAt = 0;
  },
  reset() {
    resetRedisClient();
    isConfigured = true;
    nextConnectAttemptAt = 0;
  },
};
