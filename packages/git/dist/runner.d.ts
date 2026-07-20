export interface GitRunOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowExitCodes?: number[];
    maxOutputBytes?: number;
}
export interface GitRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export declare class GitRunner {
    run(args: string[], options: GitRunOptions): Promise<GitRunResult>;
}
//# sourceMappingURL=runner.d.ts.map