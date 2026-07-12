import { after, before, describe, it } from "node:test";
import assert from "assert";
import Redis from "ioredis";
import { checkRedisRateLimit } from "@/lib/rate-limit-redis";
import {
  getReadyRedisClient,
  _redisTestHooks,
} from "@/lib/cache/redis";
import { FakeRedisClient } from "./_helpers/fake-redis";

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

  it("rebuilds the timed-out singleton after the reconnect cooldown", async () => {
    const originalDateNow = Date.now;
    let currentTime = originalDateNow();
    const wedgedClient = new FakeRedisClient({
      evalshaDelayMs: 40,
      disconnectKeepsStatus: true,
    });
    await wedgedClient.connect();
    _redisTestHooks.setClientForTesting(wedgedClient as never);
    Date.now = () => currentTime;

    try {
      await assert.rejects(
        checkRedisRateLimit(wedgedClient as never, {
          key: `test:ratelimit:recovery-timeout:${crypto.randomUUID()}`,
          windowMs: 60_000,
          maxRequests: 5,
          now: currentTime,
          timeoutMs: 25,
        }),
        /Redis eval timed out/
      );

      assert.equal(await getReadyRedisClient(), null);
      currentTime += 5_001;
      // getReadyRedisClient checks the mocked clock synchronously before its
      // first await. Restore the real clock immediately afterward so ioredis
      // internals do not inherit the test clock while connecting.
      const recoveryPromise = getReadyRedisClient();
      Date.now = originalDateNow;
      const recoveredClient = await recoveryPromise;
      assert.ok(recoveredClient);
      assert.notStrictEqual(recoveredClient, wedgedClient);

      const key = `test:ratelimit:recovered:${crypto.randomUUID()}`;
      keys.add(key);
      assert.equal(
        await checkRedisRateLimit(recoveredClient, {
          key,
          windowMs: 60_000,
          maxRequests: 5,
          now: Date.now(),
          member: "after-recovery",
        }),
        true
      );
    } finally {
      Date.now = originalDateNow;
      _redisTestHooks.reset();
    }
  });
});
