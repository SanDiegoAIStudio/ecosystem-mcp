/**
 * Get Trending Tool
 *
 * Get trending/popular packages in a category.
 */
export interface TrendingPackage {
    name: string;
    description?: string;
    weeklyDownloads: number;
    githubStars?: number;
    lastUpdate?: string;
    trending: "rising" | "stable" | "declining" | "unknown";
}
export interface TrendingResult {
    category: string;
    packages: TrendingPackage[];
    topPick?: string;
    risingStars: string[];
    notLoaded: Array<{
        name: string;
        reason: string;
    }>;
}
export declare function getTrending(category: string): Promise<TrendingResult>;
