/**
 * Check Security Tool
 *
 * Check for security advisories affecting a package.
 */

import semver from "semver";
import { checkSecurityAdvisories, type SecurityAdvisory } from "./security-client.js";
import { fetchPackageData } from "./npm-client.js";

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

function versionToCheck(given: string | undefined, latest: string): string {
  if (given === undefined || given === "latest") return latest;
  const exact = semver.valid(given);
  if (exact) return exact;
  if (semver.validRange(given) !== null) {
    const min = semver.minVersion(given);
    if (min) return min.version;
  }
  throw new Error(`Version "${given}" is not a version or range that can be checked.`);
}

function recommendationFor(
  packageName: string,
  checkedVersion: string,
  latestVersion: string,
  advisories: SecurityAdvisory[],
  bySeverity: NonNullable<SecurityCheckResult["bySeverity"]>
): string {
  const subject = `"${packageName}" ${checkedVersion}`;
  let sentence: string;
  if (advisories.length === 0) {
    sentence = `No known security advisories affect ${subject}.`;
  } else if (bySeverity.critical > 0) {
    const count = bySeverity.critical;
    sentence = count === 1
      ? `1 critical advisory affects ${subject}.`
      : `${count} critical advisories affect ${subject}.`;
  } else if (bySeverity.high > 0) {
    const count = bySeverity.high;
    sentence = count === 1
      ? `1 high severity advisory affects ${subject}.`
      : `${count} high severity advisories affect ${subject}.`;
  } else {
    const count = advisories.length;
    sentence = count === 1
      ? `1 advisory affects ${subject}.`
      : `${count} advisories affect ${subject}.`;
  }
  if (checkedVersion === latestVersion) {
    return `${sentence} That is the latest version.`;
  }
  return `${sentence} Latest version: ${latestVersion}.`;
}

export async function checkSecurity(
  packageName: string,
  version?: string
): Promise<SecurityCheckResult> {
  const npmData = await fetchPackageData(packageName);
  if (!npmData) {
    return {
      package: packageName,
      found: false,
      ...(version !== undefined ? { version } : {}),
      recommendation: `Package "${packageName}" was not found on npm, so no advisory lookup is meaningful.`,
    };
  }

  const checkedVersion = versionToCheck(version, npmData.version);
  const advisories = await checkSecurityAdvisories(packageName, checkedVersion);

  const bySeverity = {
    critical: advisories.filter((advisory) => advisory.severity === "critical").length,
    high: advisories.filter((advisory) => advisory.severity === "high").length,
    moderate: advisories.filter((advisory) => advisory.severity === "moderate").length,
    low: advisories.filter((advisory) => advisory.severity === "low").length,
  };

  return {
    package: packageName,
    found: true,
    version,
    checkedVersion,
    latestVersion: npmData.version,
    totalAdvisories: advisories.length,
    bySeverity,
    advisories,
    recommendation: recommendationFor(
      packageName,
      checkedVersion,
      npmData.version,
      advisories,
      bySeverity
    ),
  };
}
