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
    option(...args: unknown[]): CliCommand;
    argument(...args: unknown[]): CliCommand;
    action(handler: unknown): CliCommand;
}
export declare function registerNoosphereCli(program: CliCommand, rawConfig: unknown, rootConfig: unknown): void;
export declare function buildNoosphereStatusReport(rawConfig: unknown, rootConfig: unknown, options?: NoosphereDoctorOptions): Promise<NoosphereStatusReport>;
export declare function buildNoosphereDoctorReport(rawConfig: unknown, rootConfig: unknown, options?: NoosphereDoctorOptions): Promise<NoosphereDoctorReport>;
export {};
//# sourceMappingURL=cli.d.ts.map