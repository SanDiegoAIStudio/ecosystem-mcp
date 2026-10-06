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
    securityIssues: number;
    securityError?: string;
    weeklyDownloads?: number;
    recommendation?: string;
}
export interface PackageJsonAnalysis {
    totalDependencies: number;
    outdatedCount: number;
    securityIssueCount: number;
    dependencies: DependencyAnalysis[];
    devDependencies?: DependencyAnalysis[];
    summary: string;
    topPriorities: string[];
}
export declare function analyzePackageJson(packageJson: Record<string, unknown>, checkDevDeps?: boolean): Promise<PackageJsonAnalysis>;
