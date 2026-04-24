import type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryProviderDescriptor,
  MemoryProviderSearchOptions,
} from "./provider";
import { defineMemoryResult } from "./types";
import type { MemoryProviderMetadata, MemoryResult } from "./types";

export type HindsightMemoryType = "world" | "experience" | "observation";
export type HindsightRecallBudget = "low" | "mid" | "high";
export type HindsightTagsMatch = "any" | "all" | "any_strict" | "all_strict";

export interface HindsightProviderSettings {
  /** Hindsight API base URL, for example https://api.hindsight.vectorize.io. */
  baseUrl: string;

  /** Hindsight API key. Sent as a Bearer token. */
  apiKey: string;

  /** Hindsight memory bank ID to recall from. */
  bankId: string;

  /** Default recall budget sent to Hindsight when the caller does not override it. */
  defaultBudget?: HindsightRecallBudget;

  /** Default Hindsight memory types to include in recall. */
  defaultTypes?: HindsightMemoryType[];

  /** Default max tokens Hindsight should return before Noosphere budgeting. */
  defaultMaxTokens?: number;

  /** Optional fetch implementation for tests or non-standard runtimes. */
  fetch?: typeof fetch;

  /** Base provider config consumed by orchestrators. */
  providerConfig?: Partial<MemoryProviderConfig>;
}

export interface HindsightRecallOptionsMetadata extends MemoryProviderMetadata {
  types?: HindsightMemoryType[];
  budget?: HindsightRecallBudget;
  maxTokens?: number;
  queryTimestamp?: string;
  tags?: string[];
  tagsMatch?: HindsightTagsMatch;
  trace?: boolean;
}

export interface HindsightRecallResult {
  id: string;
  text: string;
  type: HindsightMemoryType | string;
  context?: string | null;
  metadata?: Record<string, string> | null;
  tags?: string[] | null;
  entities?: string[] | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  document_id?: string | null;
  chunk_id?: string | null;
  source_fact_ids?: string[] | null;
  proof_count?: number | null;
}

export interface HindsightRecallResponse {
  results?: HindsightRecallResult[];
  source_facts?: Record<string, HindsightRecallResult>;
  chunks?: Record<string, unknown>;
  entities?: Record<string, unknown>;
}

const HINDSIGHT_PROVIDER_ID = "hindsight";

export class HindsightProvider implements MemoryProvider {
  readonly descriptor: MemoryProviderDescriptor;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly bankId: string;
  private readonly defaultBudget: HindsightRecallBudget;
  private readonly defaultTypes?: HindsightMemoryType[];
  private readonly defaultMaxTokens?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: HindsightProviderSettings) {
    if (!settings.baseUrl) {
      throw new Error("HindsightProvider requires a baseUrl");
    }

    if (!settings.apiKey) {
      throw new Error("HindsightProvider requires an apiKey");
    }

    if (!settings.bankId) {
      throw new Error("HindsightProvider requires a bankId");
    }

    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    this.apiKey = settings.apiKey;
    this.bankId = settings.bankId;
    this.defaultBudget = settings.defaultBudget ?? "mid";
    this.defaultTypes = settings.defaultTypes;
    this.defaultMaxTokens = settings.defaultMaxTokens;
    this.fetchImpl = settings.fetch ?? fetch;

    this.descriptor = {
      id: HINDSIGHT_PROVIDER_ID,
      displayName: "Hindsight",
      sourceType: "hindsight",
      defaultConfig: {
        enabled: true,
        priorityWeight: 1,
        allowAutoRecall: true,
        ...settings.providerConfig,
      },
      capabilities: {
        search: true,
        getById: false,
        score: false,
        autoRecall: true,
      },
      metadata: {
        bankId: this.bankId,
      },
    };
  }

  async search(
    query: string,
    options: MemoryProviderSearchOptions = {},
  ): Promise<MemoryResult[]> {
    const metadata = (options.metadata ?? {}) as HindsightRecallOptionsMetadata;
    const response = await this.recall(query, metadata, options);
    const results = response.results ?? [];
    const limit = options.limit ?? options.config?.maxResults;
    const cappedResults = limit === undefined ? results : results.slice(0, limit);

    return cappedResults.map((result) => this.toMemoryResult(result, response));
  }

  async getById(id: string): Promise<MemoryResult | null> {
    void id;
    // Hindsight's public Recall API is query-oriented. Direct lookup is not
    // advertised as a capability, so keep this method policy-free and inert.
    return null;
  }

  private async recall(
    query: string,
    metadata: HindsightRecallOptionsMetadata,
    options: MemoryProviderSearchOptions,
  ): Promise<HindsightRecallResponse> {
    const body = {
      query,
      types: metadata.types ?? this.defaultTypes,
      budget: metadata.budget ?? this.defaultBudget,
      max_tokens: metadata.maxTokens ?? this.defaultMaxTokens,
      query_timestamp: metadata.queryTimestamp,
      tags: metadata.tags,
      tags_match: metadata.tagsMatch,
      trace: metadata.trace,
    };

    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/${encodeURIComponent(this.bankId)}/memories/recall`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(removeUndefined(body)),
        signal: options.signal,
      },
    );

    if (!response.ok) {
      throw new Error(await buildHindsightErrorMessage(response));
    }

    return (await response.json()) as HindsightRecallResponse;
  }

  private toMemoryResult(
    result: HindsightRecallResult,
    response: HindsightRecallResponse,
  ): MemoryResult {
    return defineMemoryResult({
      id: result.id,
      provider: HINDSIGHT_PROVIDER_ID,
      sourceType: "hindsight",
      title: buildHindsightTitle(result),
      content: result.text,
      curationLevel: "ephemeral",
      createdAt: result.mentioned_at ?? result.occurred_start ?? undefined,
      updatedAt: result.mentioned_at ?? result.occurred_end ?? undefined,
      canonicalRef: `hindsight:${this.bankId}:${result.id}`,
      tags: result.tags ?? undefined,
      metadata: buildHindsightMetadata(result, response),
    });
  }
}

export function createHindsightProvider(
  settings: HindsightProviderSettings,
): HindsightProvider {
  return new HindsightProvider(settings);
}

function buildHindsightTitle(result: HindsightRecallResult): string | undefined {
  return result.context ? `${result.type}: ${result.context}` : result.type;
}

function buildHindsightMetadata(
  result: HindsightRecallResult,
  response: HindsightRecallResponse,
): MemoryProviderMetadata {
  return {
    hindsightType: result.type,
    context: result.context ?? undefined,
    metadata: result.metadata ?? undefined,
    entities: result.entities ?? undefined,
    occurredStart: result.occurred_start ?? undefined,
    occurredEnd: result.occurred_end ?? undefined,
    mentionedAt: result.mentioned_at ?? undefined,
    documentId: result.document_id ?? undefined,
    chunkId: result.chunk_id ?? undefined,
    sourceFactIds: result.source_fact_ids ?? undefined,
    proofCount: result.proof_count ?? undefined,
    sourceFacts: selectSourceFacts(result.source_fact_ids, response.source_facts),
  };
}

function selectSourceFacts(
  sourceFactIds: string[] | null | undefined,
  sourceFacts: Record<string, HindsightRecallResult> | undefined,
): HindsightRecallResult[] | undefined {
  if (!sourceFactIds || !sourceFacts) {
    return undefined;
  }

  return sourceFactIds.flatMap((id) => (sourceFacts[id] ? [sourceFacts[id]] : []));
}

async function buildHindsightErrorMessage(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // Ignore body read failures; status details are still useful.
  }

  const details = [response.statusText, body].filter(Boolean).join(" — ");
  return details
    ? `Hindsight recall failed with status ${response.status}: ${details}`
    : `Hindsight recall failed with status ${response.status}`;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
