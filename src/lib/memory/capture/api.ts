import type { AutomaticMemoryCaptureConfig } from "./config";
import { readAutomaticMemoryCaptureConfig } from "./config";
import {
  MemoryCaptureError,
  PrismaMemoryCaptureRepository,
  type MemoryCaptureRepository,
} from "./repository";
import { validateMemoryCaptureRequest } from "./validation";

export type CaptureApiAuth = {
  keyId: string;
  agentPrincipalId: string | null;
};

export type ExecuteMemoryCaptureOptions = {
  auth: CaptureApiAuth;
  config?: AutomaticMemoryCaptureConfig;
  repository?: MemoryCaptureRepository;
};

export type MemoryCaptureApiResult =
  | {
      status: 202;
      body: {
        accepted: true;
        id: string;
        captureStatus: string;
        occurrenceCount: number;
        duplicate: boolean;
        statusUrl: string;
      };
    }
  | { status: number; body: { error: string } };

export async function executeMemoryCaptureRequest(
  body: unknown,
  options: ExecuteMemoryCaptureOptions,
): Promise<MemoryCaptureApiResult> {
  const config = options.config ?? readAutomaticMemoryCaptureConfig();
  if (!config.ingestionEnabled) {
    return {
      status: 503,
      body: { error: "Automatic memory capture is disabled" },
    };
  }
  if (!config.hmacKeyring) {
    return {
      status: 503,
      body: { error: "Automatic memory capture is not configured" },
    };
  }
  if (!options.auth.agentPrincipalId) {
    return {
      status: 403,
      body: { error: "API key has no automatic-memory principal binding" },
    };
  }

  const validation = validateMemoryCaptureRequest(body);
  if (!validation.ok) {
    return { status: validation.status, body: { error: validation.error } };
  }

  const repository = options.repository ?? new PrismaMemoryCaptureRepository();
  try {
    const persisted = await repository.createOrIncrement({
      auth: {
        keyId: options.auth.keyId,
        agentPrincipalId: options.auth.agentPrincipalId,
      },
      capture: validation.input,
      keyring: config.hmacKeyring,
    });
    return {
      status: 202,
      body: {
        accepted: true,
        id: persisted.id,
        captureStatus: persisted.status,
        occurrenceCount: persisted.occurrenceCount,
        duplicate: !persisted.created,
        statusUrl: `/api/memory/captures/${persisted.id}`,
      },
    };
  } catch (error) {
    if (error instanceof MemoryCaptureError) {
      return { status: error.status, body: { error: error.message } };
    }
    throw error;
  }
}
