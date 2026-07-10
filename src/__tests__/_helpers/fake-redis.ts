type PipelineCommand =
  | { method: "zremrangebyscore"; args: [string, string, string] }
  | { method: "zcard"; args: [string] }
  | { method: "zadd"; args: [string, number, string] }
  | { method: "expire"; args: [string, number] };

interface FakeRedisClientOptions {
  connectDelayMs?: number;
  rejectConnect?: boolean;
}

export class FakeRedisClient {
  status = "wait";
  connectCalls = 0;
  readonly evalKeys: string[] = [];

  private readonly values = new Map<string, string>();
  private readonly expires = new Map<string, number>();
  private readonly sortedSets = new Map<string, Array<{ score: number; member: string }>>();
  private readonly connectDelayMs: number;
  private readonly rejectConnect: boolean;

  constructor(options: FakeRedisClientOptions = {}) {
    this.connectDelayMs = options.connectDelayMs ?? 0;
    this.rejectConnect = options.rejectConnect ?? false;
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
    this.status = "end";
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

  async eval(
    _script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<number> {
    this.assertReady();
    if (numberOfKeys !== 1) {
      throw new Error("FakeRedisClient only supports one-key rate-limit scripts");
    }

    const [key, windowStart, now, maxRequests, member, ttlSeconds] = args;
    if (typeof key !== "string" || typeof member !== "string") {
      throw new Error("Invalid rate-limit script arguments");
    }
    this.evalKeys.push(key);

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
