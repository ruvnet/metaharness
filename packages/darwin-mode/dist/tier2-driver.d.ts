interface AgentTask {
    prompt: string;
    files: string[];
    buggyFile: string;
    classification: 'transient' | 'repairable' | 'unknown';
    failAttempts: number;
    backoffMs: number;
}
declare function main(): Promise<void>;
//# sourceMappingURL=tier2-driver.d.ts.map