import Redis from "ioredis";

let redisClient: Redis | null = null;
let isConfigured = true;

/**
 * Returns the Redis singleton, or null when REDIS_URL is not configured.
 * Intentionally returns null (instead of throwing) so callers can fail open
 * and skip caching without noisy error logs on every request.
 */
export function getRedisClient(): Redis | null {
  if (!isConfigured) {
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
    retryStrategy() {
      // Reconnect every 5 seconds without destroying the client
      return 5000;
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

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
  isConfigured = true;
}
