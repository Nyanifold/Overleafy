import { type BindingStorePort, type ProjectBinding } from "@nyanifold/core";
import { z } from "zod";
export declare const projectBindingSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    profile: z.ZodString;
    projectId: z.ZodString;
    projectName: z.ZodOptional<z.ZodString>;
    webUrl: z.ZodURL;
    gitUrl: z.ZodURL;
    remoteName: z.ZodString;
    localBranch: z.ZodString;
    remoteBranch: z.ZodString;
    sync: z.ZodObject<{
        mergeStrategy: z.ZodLiteral<"merge">;
        include: z.ZodArray<z.ZodString>;
        exclude: z.ZodArray<z.ZodString>;
        quietPeriodMs: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare class FileBindingStore implements BindingStorePort {
    read(repositoryPath: string): Promise<ProjectBinding | undefined>;
    write(repositoryPath: string, binding: ProjectBinding): Promise<void>;
    delete(repositoryPath: string): Promise<void>;
}
//# sourceMappingURL=binding-store.d.ts.map