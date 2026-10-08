/**
 * Security Advisory Client
 *
 * Checks for security vulnerabilities using the GitHub Security Advisories API.
 */
export declare class AdvisoryLookupError extends Error {
    constructor(message: string);
}
export interface SecurityAdvisory {
    id: string;
    severity: "critical" | "high" | "moderate" | "low";
    title: string;
    description?: string;
    cve?: string;
    patchedVersions?: string;
    vulnerableVersions?: string;
    publishedAt?: string;
    url?: string;
}
export declare function checkSecurityAdvisories(packageName: string, version: string): Promise<SecurityAdvisory[]>;
