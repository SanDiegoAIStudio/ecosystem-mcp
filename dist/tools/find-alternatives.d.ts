/**
 * Find Alternatives Tool
 *
 * Find alternative packages to a given package.
 */
export declare function alternativeNotes(): Record<string, {
    pros: string[];
    cons: string[];
}>;
export interface Alternative {
    name: string;
    description?: string;
    weeklyDownloads?: number;
    githubStars?: number;
    pros: string[];
    cons: string[];
    migrationEffort: "low" | "medium" | "high";
}
export interface AlternativesResult {
    original: string;
    alternatives: Alternative[];
    notLoaded: Array<{
        name: string;
        reason: string;
    }>;
    recommendation?: string;
}
export declare function findAlternatives(packageName: string): Promise<AlternativesResult>;
