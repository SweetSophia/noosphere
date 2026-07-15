import { parseCaptureHmacKeyring, type CaptureHmacKeyring } from "./crypto";

export type AutomaticMemoryCaptureConfig = {
  ingestionEnabled: boolean;
  hmacKeyring?: CaptureHmacKeyring;
};

export function readAutomaticMemoryCaptureConfig(
  env: Record<string, string | undefined> = process.env,
): AutomaticMemoryCaptureConfig {
  const rawEnabled = env.NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED;
  const ingestionEnabled = rawEnabled === "true";

  if (rawEnabled !== undefined && rawEnabled !== "true" && rawEnabled !== "false") {
    throw new Error(
      "NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED must be true or false",
    );
  }

  const hasMaintenanceKeyring =
    env.NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION !== undefined ||
    env.NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS !== undefined;

  if (!ingestionEnabled && !hasMaintenanceKeyring) {
    return { ingestionEnabled: false };
  }
  return {
    ingestionEnabled,
    hmacKeyring: parseCaptureHmacKeyring(env),
  };
}
