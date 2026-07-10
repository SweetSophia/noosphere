import { after, before, describe, it } from "node:test";
import assert from "assert";
import Redis from "ioredis";
import { checkRedisRateLimit } from "@/lib/rate-limit-redis";

const redisUrl = process.env.REDIS_URL;

describe("Redis rate limiter integration", { skip: !redisUrl }, () => {
  let firstClient: Redis;
  let secondClient: Redis;
  const keys = new Set<string>();

  before(async () => {
    firstClient = new Redis(redisUrl!, { lazyConnect: true });
    secondClient = new Redis(redisUrl!, { lazyConnect: true });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
  });

  after(async () => {
    if (keys.size > 0) {
      await firstClient.del(...keys);
    }
    firstClient.disconnect();
    secondClient.disconnect();
  });

  it("admits exactly the shared limit across concurrent Redis clients", async () => {
    const key = `test:ratelimit:atomic:${crypto.randomUUID()}`;
    keys.add(key);
    const now = Date.now();

    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        checkRedisRateLimit(index % 2 === 0 ? firstClient : secondClient, {
          key,
          windowMs: 60_000,
          maxRequests: 5,
          now,
          member: `${now}:${index}`,
        })
      )
    );

    assert.equal(decisions.filter(Boolean).length, 5);
    assert.equal(decisions.filter((decision) => decision === false).length, 15);
  });

  it("releases a request exactly at the sliding-window boundary", async () => {
    const key = `test:ratelimit:boundary:${crypto.randomUUID()}`;
    keys.add(key);

    assert.equal(
      await checkRedisRateLimit(firstClient, {
        key,
        windowMs: 1_000,
        maxRequests: 1,
        now: 10_000,
        member: "first",
      }),
      true
    );
    assert.equal(
      await checkRedisRateLimit(secondClient, {
        key,
        windowMs: 1_000,
        maxRequests: 1,
        now: 11_000,
        member: "boundary",
      }),
      true
    );
  });
});
