/**
 * Research Package Tool
 *
 * Deep dive on a specific npm package.
 */
export interface PackageResearch {
    name: string;
    description?: string;
    currentVersion?: string;
    latestVersion: string;
    versionsBehind?: number;
    weeklyDownloads?: number;
    monthlyDownloads?: number;
    github?: {
        stars: number;
        forks: number;
        openIssues: number;
        lastPush: string;
        archived: boolean;
    };
    security: {
        checkedVersion: string;
        advisoryCount: number | null;
        criticalCount: number | null;
        highCount: number | null;
        error?: string;
        advisories: Array<{
            id: string;
            severity: string;
            title: string;
        }>;
    };
    maintenance: {
        lastPublish?: string;
        daysSinceLastPublish?: number;
        maintainerCount?: number;
    };
    typescript: boolean;
    license?: string;
    homepage?: string;
    keywords?: string[];
    deprecated?: string;
    versionNote?: string;
}
export declare function researchPackage(packageName: string, currentVersion?: string): Promise<PackageResearch>;
