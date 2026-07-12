import { createHash } from "node:crypto";
import { REDIS_RATE_LIMIT_SCRIPT } from "@/lib/rate-limit-redis";

type PipelineCommand =
  | { method: "zremrangebyscore"; args: [string, string, string] }
  | { method: "zcard"; args: [string] }
  | { method: "zadd"; args: [string, number, string] }
  | { method: "expire"; args: [string, number] };

interface FakeRedisClientOptions {
  connectDelayMs?: number;
  rejectConnect?: boolean;
  evalshaDelayMs?: number;
  evalshaError?: Error;
  evalDelayMs?: number;
  evalReturnValue?: number;
  disconnectKeepsStatus?: boolean;
  disconnectError?: Error;
}

export class FakeRedisClient {
  status = "wait";
  connectCalls = 0;
  disconnectCalls = 0;
  readonly evalKeys: string[] = [];
  evalshaCalls = 0;
  evalCalls = 0;

  private readonly values = new Map<string, string>();
  private readonly expires = new Map<string, number>();
  private readonly sortedSets = new Map<string, Array<{ score: number; member: string }>>();
  private readonly connectDelayMs: number;
  private readonly rejectConnect: boolean;
  private readonly evalshaDelayMs: number;
  private readonly evalshaError: Error | undefined;
  private readonly evalDelayMs: number;
  private readonly evalReturnValue: number | undefined;
  private readonly disconnectKeepsStatus: boolean;
  private readonly disconnectError: Error | undefined;

  constructor(options: FakeRedisClientOptions = {}) {
    this.connectDelayMs = options.connectDelayMs ?? 0;
    this.rejectConnect = options.rejectConnect ?? false;
    this.evalshaDelayMs = options.evalshaDelayMs ?? 0;
    this.evalshaError = options.evalshaError;
    this.evalDelayMs = options.evalDelayMs ?? 0;
    this.evalReturnValue = options.evalReturnValue;
    this.disconnectKeepsStatus = options.disconnectKeepsStatus ?? false;
    this.disconnectError = options.disconnectError;
  }

  async connect() {
    this.connectCalls += 1;
    if (this.connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    }
    if (this.rejectConnect) {
      throw new Error("Redis connection failed");
    }
    this.status = "ready";
  }

  disconnect() {
    this.disconnectCalls += 1;
    if (this.disconnectError) {
      throw this.disconnectError;
    }
    if (!this.disconnectKeepsStatus) {
      this.status = "end";
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertReady();
    const expiry = this.expires.get(key);
    if (expiry !== undefined && Date.now() > expiry) {
      this.values.delete(key);
      this.expires.delete(key);
      return null;
    }
    return this.values.get(key) ?? null;
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<string> {
    this.assertReady();
    this.values.set(key, value);
    this.expires.set(key, Date.now() + ttlSeconds * 1000);
    return "OK";
  }

  zremrangebyscore(key: string, min: string, max: string): number {
    this.assertReady();
    const entries = this.sortedSets.get(key) ?? [];
    const minScore = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
    const maxScore = Number(max);
    const retained = entries.filter((entry) => entry.score < minScore || entry.score > maxScore);
    this.sortedSets.set(key, retained);
    return entries.length - retained.length;
  }

  zcard(key: string): number {
    this.assertReady();
    return this.sortedSets.get(key)?.length ?? 0;
  }

  zadd(key: string, score: number, member: string): number {
    this.assertReady();
    const entries = this.sortedSets.get(key) ?? [];
    if (entries.some((entry) => entry.member === member)) {
      return 0;
    }
    entries.push({ score, member });
    this.sortedSets.set(key, entries);
    return 1;
  }

  expire(key: string, seconds: number): number {
    this.assertReady();
    this.expires.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  private static readonly SCRIPT_SHA =
    createHash("sha1").update(REDIS_RATE_LIMIT_SCRIPT).digest("hex");

  async evalsha(
    sha1: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<number> {
    this.assertReady();
    this.evalshaCalls++;
    await delay(this.evalshaDelayMs);
    if (this.evalshaError) {
      throw this.evalshaError;
    }
    this.assertReady();
    if (sha1 !== FakeRedisClient.SCRIPT_SHA) {
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    }
    // Delegate to the existing eval logic (skip the script body arg).
    this.evalKeys.push(args[0] as string);
    return this.runRateLimitScript(numberOfKeys, args);
  }

  async eval(
    _script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<number> {
    this.assertReady();
    this.evalCalls += 1;
    await delay(this.evalDelayMs);
    if (this.evalReturnValue !== undefined) {
      this.evalKeys.push(args[0] as string);
      return this.evalReturnValue;
    }
    this.assertReady();
    if (numberOfKeys !== 1) {
      throw new Error("FakeRedisClient only supports one-key rate-limit scripts");
    }

    // Validate basic types (runRateLimitScript does full validation).
    if (typeof args[0] !== "string" || typeof args[4] !== "string") {
      throw new Error("Invalid rate-limit script arguments");
    }
    this.evalKeys.push(args[0] as string);
    return this.runRateLimitScript(numberOfKeys, args);
  }

  private runRateLimitScript(
    numberOfKeys: number,
    args: Array<string | number>
  ): number {
    if (numberOfKeys !== 1) {
      throw new Error("FakeRedisClient only supports one-key rate-limit scripts");
    }

    const [key, windowStart, now, maxRequests, member, ttlSeconds] = args;
    if (typeof key !== "string" || typeof member !== "string") {
      throw new Error("Invalid rate-limit script arguments");
    }

    this.zremrangebyscore(key, "-inf", String(windowStart));
    const count = this.zcard(key);
    if (count >= Number(maxRequests)) {
      return 0;
    }

    this.zadd(key, Number(now), member);
    this.expire(key, Number(ttlSeconds));
    return 1;
  }

  pipeline() {
    const commands: PipelineCommand[] = [];

    const pipeline = {
      zremrangebyscore: (key: string, min: string, max: string) => {
        commands.push({ method: "zremrangebyscore", args: [key, min, max] });
        return pipeline;
      },
      zcard: (key: string) => {
        commands.push({ method: "zcard", args: [key] });
        return pipeline;
      },
      zadd: (key: string, score: number, member: string) => {
        commands.push({ method: "zadd", args: [key, score, member] });
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        commands.push({ method: "expire", args: [key, seconds] });
        return pipeline;
      },
      exec: async () => commands.map((command) => {
        try {
          let result: number;
          if (command.method === "zremrangebyscore") {
            result = this.zremrangebyscore(...command.args);
          } else if (command.method === "zcard") {
            result = this.zcard(...command.args);
          } else if (command.method === "zadd") {
            result = this.zadd(...command.args);
          } else {
            result = this.expire(...command.args);
          }
          return [null, result] as [null, unknown];
        } catch (error) {
          return [error as Error, null] as [Error, null];
        }
      }),
    };

    return pipeline;
  }

  private assertReady() {
    if (this.status !== "ready") {
      throw new Error("Redis command executed before client was ready");
    }
  }
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
