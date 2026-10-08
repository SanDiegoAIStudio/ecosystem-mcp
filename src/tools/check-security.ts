/**
 * Check Security Tool
 *
 * Check for security advisories affecting a package.
 */

import { checkSecurityAdvisories, type SecurityAdvisory } from "./security-client.js";
import { fetchPackageData } from "./npm-client.js";

export interface SecurityCheckResult {
  package: string;
  version?: string;
  latestVersion?: string;
  totalAdvisories: number;
  bySeverity: {
    critical: number;
    high: number;
    moderate: number;
    low: number;
  };
  advisories: SecurityAdvisory[];
  recommendation?: string;
}

export async function checkSecurity(
  packageName: string,
  version?: string
): Promise<SecurityCheckResult> {
  // Fetch package info and advisories in parallel; advisory lookup failures propagate.
  const [npmData, advisories] = await Promise.all([
    fetchPackageData(packageName),
    checkSecurityAdvisories(packageName, version),
  ]);

  // Count by severity
  const bySeverity = {
    critical: advisories.filter((a) => a.severity === "critical").length,
    high: advisories.filter((a) => a.severity === "high").length,
    moderate: advisories.filter((a) => a.severity === "moderate").length,
    low: advisories.filter((a) => a.severity === "low").length,
  };

  // Generate recommendation
  let recommendation: string | undefined;

  if (advisories.length === 0) {
    recommendation = `No known security advisories for "${packageName}"${version ? ` ${version}` : ""}.`;
  } else if (bySeverity.critical > 0) {
    recommendation = `⚠️ CRITICAL: ${bySeverity.critical} critical vulnerabilities found. Update immediately!`;
  } else if (bySeverity.high > 0) {
    recommendation = `⚠️ HIGH: ${bySeverity.high} high severity issues. Update recommended.`;
  } else {
    recommendation = `${advisories.length} advisory(ies) found. Review and consider updating.`;
  }

  // Add update command if there's a newer version
  if (npmData && version && npmData.version !== version) {
    recommendation += ` Latest version: ${npmData.version}`;
  }

  return {
    package: packageName,
    version,
    latestVersion: npmData?.version,
    totalAdvisories: advisories.length,
    bySeverity,
    advisories,
    recommendation,
  };
}
