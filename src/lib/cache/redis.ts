import Redis from "ioredis";

let redisClient: Redis | null = null;

/**
 * Returns the Redis singleton, or null when REDIS_URL is not configured.
 * Intentionally returns null (instead of throwing) so callers can fail open
 * and skip caching without noisy error logs on every request.
 */
export function getRedisClient(): Redis | null {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 3) {
        // All retries exhausted — reset singleton so next call can try fresh
        redisClient = null;
        return null;
      }
      return Math.min(times * 100, 3000);
    },
    lazyConnect: true,
  });

  client.on("error", (err) => {
    // Only log non-connection errors (connection errors are expected when Redis is down)
    if (!(err instanceof Error) || !err.message.includes("ECONNREFUSED")) {
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
}
