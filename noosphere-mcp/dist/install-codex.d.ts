export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}
export type RunCodex = (args: string[]) => CommandResult;
export interface CodexInstallOptions {
    homeDir: string;
    codexHomeDir?: string;
    packageVersion: string;
    skillSourceFile: string;
    runCodex?: RunCodex;
}
export interface CodexInstallResult {
    serverAction: "installed" | "upgraded" | "configured" | "unchanged";
    skillAction: "installed" | "unchanged";
}
export declare class CodexInstallError extends Error {
    constructor(message: string);
}
export declare function installCodexIntegration(options: CodexInstallOptions): Promise<CodexInstallResult>;
//# sourceMappingURL=install-codex.d.ts.map