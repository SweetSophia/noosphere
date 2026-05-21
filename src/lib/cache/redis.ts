import Redis from "ioredis";

let redisClient: Redis | null = null;
let isConfigured = true;
let nextConnectAttemptAt = 0;

const REDIS_RECONNECT_COOLDOWN_MS = 5000;

function resetRedisClient(client: Redis | null = redisClient): void {
  if (client) {
    client.disconnect();
  }
  redisClient = null;
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
    return redisClient;
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
    await client.connect();
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
    isConfigured = true;
    nextConnectAttemptAt = 0;
  },
  reset() {
    resetRedisClient();
    isConfigured = true;
    nextConnectAttemptAt = 0;
  },
};
