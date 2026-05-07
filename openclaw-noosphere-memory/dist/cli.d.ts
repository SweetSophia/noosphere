import { NoosphereMemoryClient, type NoosphereStatusResponse } from "./client.js";
export type NoosphereCliCheckStatus = "pass" | "warn" | "fail";
export interface NoosphereCliCheck {
    id: string;
    label: string;
    status: NoosphereCliCheckStatus;
    message: string;
    details?: unknown;
}
export interface NoosphereDoctorReport {
    ok: boolean;
    baseUrl: string;
    apiKeyConfigured: boolean;
    apiKeyRedacted?: string;
    checks: NoosphereCliCheck[];
}
export interface NoosphereStatusReport {
    ok: boolean;
    baseUrl: string;
    apiKeyConfigured: boolean;
    health?: {
        ok: boolean;
        status?: number;
        error?: string;
    };
    memoryStatus?: NoosphereStatusResponse;
}
type FetchLike = typeof fetch;
export interface NoosphereDoctorOptions {
    fetchImpl?: FetchLike;
    client?: Pick<NoosphereMemoryClient, "status">;
}
interface CliCommand {
    command(name: string): CliCommand;
    description(text: string): CliCommand;
    option(flags: string, description?: string, parserOrDefault?: CliOptionParser | unknown, defaultValue?: unknown): CliCommand;
    argument(name: string, description?: string, defaultValue?: unknown): CliCommand;
    action<TArgs extends readonly unknown[]>(handler: CliActionHandler<TArgs>): CliCommand;
}
type CliOptionParser = (value: string) => unknown;
type CliActionHandler<TArgs extends readonly unknown[]> = (...args: TArgs) => void | Promise<void>;
export declare function registerNoosphereCli(program: CliCommand, rawConfig: unknown, rootConfig: unknown): void;
export declare function buildNoosphereStatusReport(rawConfig: unknown, rootConfig: unknown, options?: NoosphereDoctorOptions): Promise<NoosphereStatusReport>;
export declare function buildNoosphereDoctorReport(rawConfig: unknown, rootConfig: unknown, options?: NoosphereDoctorOptions): Promise<NoosphereDoctorReport>;
export {};
//# sourceMappingURL=cli.d.ts.map