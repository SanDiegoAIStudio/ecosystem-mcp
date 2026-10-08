/**
 * Compare Packages Tool
 *
 * Compare multiple npm packages side-by-side.
 */

import { fetchPackageData, fetchDownloads, hasTypeScriptSupport, NpmLookupError, repositoryUrl } from "./npm-client.js";
import { fetchRepoFromNpmUrl } from "./github-client.js";

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

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function leader(
  entries: PackageComparisonEntry[],
  key: "weeklyDownloads" | "githubStars"
): PackageComparisonEntry | undefined {
  let best: PackageComparisonEntry | undefined;
  for (const entry of entries) {
    const value = entry[key];
    if (typeof value !== "number") continue;
    if (!best || value > (best[key] as number)) best = entry;
  }
  return best;
}

function recommendationFor(results: PackageComparisonEntry[]): string | undefined {
  const found = results.filter((entry) => entry.status === "found");
  const failed = results.filter((entry) => entry.status === "lookup-failed");
  const missing = results.filter((entry) => entry.status === "not-found");
  if (found.length === 0 && failed.length === 0) return undefined;

  const sentences: string[] = [];
  const downloadLeader = leader(found, "weeklyDownloads");
  if (downloadLeader && typeof downloadLeader.weeklyDownloads === "number") {
    sentences.push(
      `"${downloadLeader.name}" has the most weekly downloads (${formatCount(downloadLeader.weeklyDownloads)}).`
    );
  }
  const starLeader = leader(found, "githubStars");
  if (starLeader && typeof starLeader.githubStars === "number") {
    sentences.push(
      `"${starLeader.name}" has the most GitHub stars (${formatCount(starLeader.githubStars)}).`
    );
  }
  const missingDownloads = found
    .filter((entry) => typeof entry.weeklyDownloads !== "number")
    .map((entry) => entry.name);
  if (missingDownloads.length > 0) {
    sentences.push(`Weekly downloads were not available for: ${missingDownloads.join(", ")}.`);
  }
  const missingStars = found
    .filter((entry) => typeof entry.githubStars !== "number")
    .map((entry) => entry.name);
  if (missingStars.length > 0) {
    sentences.push(`GitHub stars were not available for: ${missingStars.join(", ")}.`);
  }
  if (missing.length > 0) {
    sentences.push(`Not found on npm: ${missing.map((entry) => entry.name).join(", ")}.`);
  }
  if (failed.length > 0) {
    sentences.push(`Lookup failed for: ${failed.map((entry) => entry.name).join(", ")}.`);
  }
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

export async function comparePackages(packages: string[]): Promise<PackageComparison> {
  if (packages.length < 2 || packages.length > 5) {
    throw new Error("Please provide 2-5 packages to compare");
  }

  const results = await Promise.all(
    packages.map(async (pkg): Promise<PackageComparisonEntry> => {
      try {
        const npmData = await fetchPackageData(pkg);
        if (!npmData) return { name: pkg, status: "not-found" };

        const downloads = await fetchDownloads(pkg, "last-week");
        const githubData = await fetchRepoFromNpmUrl(repositoryUrl(npmData.repository));
        const lastUpdate = npmData.time?.[npmData.version];
        return {
          name: npmData.name,
          status: "found",
          version: npmData.version,
          ...(npmData.description ? { description: npmData.description } : {}),
          ...(typeof downloads?.downloads === "number" ? { weeklyDownloads: downloads.downloads } : {}),
          ...(typeof githubData?.stargazers_count === "number"
            ? { githubStars: githubData.stargazers_count }
            : {}),
          ...(lastUpdate ? { lastUpdate } : {}),
          typescript: hasTypeScriptSupport(npmData),
          ...(npmData.license ? { license: npmData.license } : {}),
          maintainers: npmData.maintainers?.length ?? 0,
        };
      } catch (error) {
        if (error instanceof NpmLookupError) {
          return { name: pkg, status: "lookup-failed", error: error.message };
        }
        throw error;
      }
    })
  );

  const recommendation = recommendationFor(results);
  return {
    packages: results,
    ...(recommendation ? { recommendation } : {}),
  };
}
