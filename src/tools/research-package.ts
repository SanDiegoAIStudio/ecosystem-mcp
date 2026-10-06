/**
 * Research Package Tool
 *
 * Deep dive on a specific npm package.
 */

import semver from "semver";
import { fetchPackageData, fetchDownloads } from "./npm-client.js";
import { fetchRepoFromNpmUrl } from "./github-client.js";
import { AdvisoryLookupError, checkSecurityAdvisories } from "./security-client.js";

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
    advisoryCount: number;
    criticalCount: number;
    highCount: number;
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
}

export async function researchPackage(
  packageName: string,
  currentVersion?: string
): Promise<PackageResearch> {
  let securityError: string | undefined;
  // Fetch data in parallel
  const [npmData, weeklyDownloads, monthlyDownloads, advisories] =
    await Promise.all([
      fetchPackageData(packageName),
      fetchDownloads(packageName, "last-week"),
      fetchDownloads(packageName, "last-month"),
      checkSecurityAdvisories(packageName, currentVersion).catch((error: unknown) => {
        if (!(error instanceof AdvisoryLookupError)) throw error;
        securityError = error.message;
        return [];
      }),
    ]);

  if (!npmData) {
    throw new Error(`Package "${packageName}" not found on npm`);
  }

  // Get GitHub data if available
  const repoUrl = npmData.repository?.url;
  const githubData = await fetchRepoFromNpmUrl(repoUrl);

  // Calculate versions behind
  let versionsBehind: number | undefined;
  if (currentVersion && npmData.version) {
    const versions = npmData.versions ? Object.keys(npmData.versions) : [];
    const validVersions = versions.filter((v) => semver.valid(v));
    const sortedVersions = validVersions.sort(semver.rcompare);
    const currentIndex = sortedVersions.findIndex(
      (v) => semver.eq(v, currentVersion)
    );
    if (currentIndex > 0) {
      versionsBehind = currentIndex;
    }
  }

  // Calculate days since last publish
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

  // Check for TypeScript support
  const hasTypes =
    npmData.keywords?.some(
      (k) => k.toLowerCase() === "typescript" || k.toLowerCase() === "types"
    ) ||
    npmData.name.startsWith("@types/") ||
    false;

  // Count security issues
  const criticalCount = advisories.filter(
    (a) => a.severity === "critical"
  ).length;
  const highCount = advisories.filter((a) => a.severity === "high").length;

  return {
    name: npmData.name,
    description: npmData.description,
    currentVersion,
    latestVersion: npmData.version,
    versionsBehind,
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
      advisoryCount: advisories.length,
      criticalCount,
      highCount,
      error: securityError,
      advisories: advisories.slice(0, 5).map((a) => ({
        id: a.id,
        severity: a.severity,
        title: a.title,
      })),
    },
    maintenance: {
      lastPublish,
      daysSinceLastPublish,
      maintainerCount: npmData.maintainers?.length,
    },
    typescript: hasTypes,
    license: npmData.license,
    homepage: npmData.homepage,
    keywords: npmData.keywords?.slice(0, 10),
  };
}
