/**
 * NPM Registry Client
 *
 * Fetches package data from the npm registry.
 */
export interface NpmPackageData {
    name: string;
    description?: string;
    version: string;
    license?: string;
    homepage?: string;
    repository?: {
        type?: string;
        url?: string;
    } | string;
    keywords?: string[];
    types?: string;
    typings?: string;
    maintainers?: Array<{
        name: string;
        email: string;
    }>;
    time?: Record<string, string>;
    versions?: Record<string, unknown>;
    "dist-tags"?: Record<string, string>;
}
export interface NpmDownloads {
    downloads: number;
    start: string;
    end: string;
    package: string;
}
export declare function repositoryUrl(repository: NpmPackageData["repository"]): string | undefined;
export declare class NpmLookupError extends Error {
    constructor(message: string);
}
export declare function hasTypeScriptSupport(pkg: NpmPackageData): boolean;
export declare function deprecationMessage(pkg: NpmPackageData): string | undefined;
export declare function fetchPackageData(packageName: string): Promise<NpmPackageData | null>;
export declare function fetchDownloads(packageName: string, period?: "last-week" | "last-month" | "last-year"): Promise<NpmDownloads | null>;
