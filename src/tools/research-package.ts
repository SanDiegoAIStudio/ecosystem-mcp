/**
 * Research Package Tool
 *
 * Deep dive on a specific npm package.
 */

import semver from "semver";
import {
  deprecationMessage,
  fetchDownloads,
  fetchPackageData,
  hasTypeScriptSupport,
  repositoryUrl,
} from "./npm-client.js";
import { fetchRepoFromNpmUrl } from "./github-client.js";
import { AdvisoryLookupError, checkSecurityAdvisories, type SecurityAdvisory } from "./security-client.js";
import { resolveVersion, versionResolutionSentence } from "./version-resolve.js";

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

function stableVersionsAhead(versions: Record<string, unknown> | undefined, current: string): number {
  let count = 0;
  for (const version of Object.keys(versions ?? {})) {
    if (semver.valid(version) === null) continue;
    if (semver.prerelease(version) !== null) continue;
    if (semver.gt(version, current)) count += 1;
  }
  return count;
}

export async function researchPackage(
  packageName: string,
  currentVersion?: string
): Promise<PackageResearch> {
  const npmData = await fetchPackageData(packageName);
  if (!npmData) {
    throw new Error(`Package "${packageName}" not found on npm`);
  }

  let checkedVersion = npmData.version;
  let versionNote: string | undefined;
  let versionsBehind: number | undefined;
  if (currentVersion === undefined || currentVersion.trim() === "") {
    const resolved = resolveVersion(undefined, npmData);
    if (resolved.kind !== "none") checkedVersion = resolved.version;
  } else {
    const resolved = resolveVersion(currentVersion, npmData);
    if (resolved.kind === "none") {
      versionNote = `${resolved.reason} Advisories were checked for the latest version, ${npmData.version}.`;
      checkedVersion = npmData.version;
    } else {
      checkedVersion = resolved.version;
      if (semver.valid(resolved.version)) {
        versionsBehind = stableVersionsAhead(npmData.versions, resolved.version);
      }
      if (resolved.kind === "range" || resolved.kind === "tag") {
        versionNote = versionResolutionSentence(resolved);
      }
    }
  }

  let securityError: string | undefined;
  let advisories: SecurityAdvisory[] = [];
  const [weeklyDownloads, monthlyDownloads, githubData] = await Promise.all([
    fetchDownloads(packageName, "last-week"),
    fetchDownloads(packageName, "last-month"),
    fetchRepoFromNpmUrl(repositoryUrl(npmData.repository)),
    checkSecurityAdvisories(packageName, checkedVersion).then(
      (found) => {
        advisories = found;
      },
      (error: unknown) => {
        if (!(error instanceof AdvisoryLookupError)) throw error;
        securityError = error.message;
        advisories = [];
      }
    ),
  ]);

  let daysSinceLastPublish: number | undefined;
  let lastPublish: string | undefined;
  if (npmData.time) {
    lastPublish = npmData.time[npmData.version];
    if (lastPublish) {
      const lastDate = new Date(lastPublish);
      daysSinceLastPublish = Math.floor(
        (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
      );
    }
  }

  const deprecated = deprecationMessage(npmData);
  const advisoryCount = securityError ? null : advisories.length;
  const criticalCount = securityError
    ? null
    : advisories.filter((advisory) => advisory.severity === "critical").length;
  const highCount = securityError
    ? null
    : advisories.filter((advisory) => advisory.severity === "high").length;

  return {
    name: npmData.name,
    description: npmData.description,
    currentVersion,
    latestVersion: npmData.version,
    ...(versionsBehind !== undefined ? { versionsBehind } : {}),
    weeklyDownloads: weeklyDownloads?.downloads,
    monthlyDownloads: monthlyDownloads?.downloads,
    github: githubData
      ? {
          stars: githubData.stargazers_count,
          forks: githubData.forks_count,
          openIssues: githubData.open_issues_count,
          lastPush: githubData.pushed_at,
          archived: githubData.archived,
        }
      : undefined,
    security: {
      checkedVersion,
      advisoryCount,
      criticalCount,
      highCount,
      ...(securityError ? { error: securityError } : {}),
      advisories: advisories.slice(0, 5).map((advisory) => ({
        id: advisory.id,
        severity: advisory.severity,
        title: advisory.title,
      })),
    },
    maintenance: {
      lastPublish,
      daysSinceLastPublish,
      maintainerCount: npmData.maintainers?.length,
    },
    typescript: hasTypeScriptSupport(npmData),
    license: npmData.license,
    homepage: npmData.homepage,
    keywords: npmData.keywords?.slice(0, 10),
    ...(deprecated ? { deprecated } : {}),
    ...(versionNote ? { versionNote } : {}),
  };
}
