/**
 * Analyze Package.json Tool
 *
 * Analyze a project's dependencies and provide recommendations.
 */
export interface DependencyAnalysis {
    name: string;
    current: string;
    latest?: string;
    status: "up-to-date" | "patch" | "minor" | "major" | "unknown";
    securityIssues: number | null;
    securityError?: string;
    weeklyDownloads?: number;
    recommendation?: string;
    deprecated?: string;
}
export interface AnalysisCounts {
    analyzed: number;
    total: number;
}
export interface PackageJsonAnalysis {
    totalDependencies: number;
    analyzedDependencies: number;
    outdatedCount: number;
    securityIssueCount: number;
    dependencies: DependencyAnalysis[];
    devDependencies?: DependencyAnalysis[];
    summary: string;
    topPriorities: string[];
    analyzedCounts?: {
        dependencies?: AnalysisCounts;
        devDependencies?: AnalysisCounts;
    };
}
export declare function analyzePackageJson(packageJson: Record<string, unknown>, checkDevDeps?: boolean): Promise<PackageJsonAnalysis>;
