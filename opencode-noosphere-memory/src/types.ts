export interface NoospherePluginConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  autoRecall: boolean;
  autoRecallInjectOn: "first" | "always";
  autoRecallMax: number;
  autoRecallTokenBudget: number;
  autoSave: boolean;
  autoSaveDebounceMs: number;
  autoSaveTopicId?: string;
  authorName: string;
}

export interface RecallResult {
  provider?: string;
  id?: string;
  canonicalRef?: string;
  title?: string;
  excerpt?: string;
  content?: string;
  score?: number;
  url?: string;
}

export interface MemoryRecallResponse {
  results?: RecallResult[];
  totalBeforeCap?: number;
  mode?: "auto" | "inspection";
  tokenBudgetUsed?: number;
  promptInjectionText?: string;
  providerMeta?: unknown[];
}

export interface MemorySaveResponse {
  success?: boolean;
  candidate?: {
    id: string;
    title: string;
    slug: string;
    topicId: string;
    url?: string;
  };
  strippedBlocks?: string[];
}

export interface TopicListResponse {
  topics?: Array<{
    id: string;
    name: string;
    slug: string;
    parentId?: string | null;
  }>;
}

export interface SessionPrompt {
  messageId: string;
  content: string;
  timestamp: number;
}
