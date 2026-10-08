/**
 * Compare Packages Tool
 *
 * Compare multiple npm packages side-by-side.
 */
export interface PackageComparisonEntry {
    name: string;
    status: "found" | "not-found" | "lookup-failed";
    version?: string;
    description?: string;
    weeklyDownloads?: number;
    githubStars?: number;
    lastUpdate?: string;
    typescript?: boolean;
    license?: string;
    maintainers?: number;
    error?: string;
}
export interface PackageComparison {
    packages: PackageComparisonEntry[];
    recommendation?: string;
}
export declare function comparePackages(packages: string[]): Promise<PackageComparison>;
