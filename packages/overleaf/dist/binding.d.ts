import { type ProjectBinding } from "@nyanifold/core";
export interface CreateBindingOptions {
    project: string;
    projectName?: string;
    profile?: string;
    webUrl?: string;
    gitUrl?: string;
    remoteName?: string;
    localBranch: string;
    remoteBranch?: string;
}
export declare function extractProjectId(project: string): string;
export declare function createProjectBinding(options: CreateBindingOptions): ProjectBinding;
//# sourceMappingURL=binding.d.ts.map