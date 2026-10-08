/**
 * Check Security Tool
 *
 * Check for security advisories affecting a package.
 */
import { type SecurityAdvisory } from "./security-client.js";
export interface SecurityCheckResult {
    package: string;
    found: boolean;
    version?: string;
    checkedVersion?: string;
    latestVersion?: string;
    totalAdvisories?: number;
    bySeverity?: {
        critical: number;
        high: number;
        moderate: number;
        low: number;
    };
    advisories?: SecurityAdvisory[];
    recommendation?: string;
}
export declare function checkSecurity(packageName: string, version?: string): Promise<SecurityCheckResult>;
