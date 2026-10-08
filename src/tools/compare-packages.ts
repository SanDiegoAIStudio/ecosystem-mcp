/**
 * Compare Packages Tool
 *
 * Compare multiple npm packages side-by-side.
 */

import { fetchPackageData, fetchDownloads, hasTypeScriptSupport, repositoryUrl } from "./npm-client.js";
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

function metricSentence(
  entries: PackageComparisonEntry[],
  key: "weeklyDownloads" | "githubStars",
  noun: string
): string | undefined {
  const withValue = entries.filter((entry) => typeof entry[key] === "number");
  if (withValue.length < 2) return undefined;
  let max = withValue[0][key] as number;
  for (const entry of withValue) {
    const value = entry[key] as number;
    if (value > max) max = value;
  }
  const leaders = withValue.filter((entry) => entry[key] === max);
  const formatted = formatCount(max);
  if (leaders.length >= 2) {
    const names = leaders.map((entry) => `"${entry.name}"`);
    const last = names[names.length - 1];
    const head = names.slice(0, -1).join(", ");
    return `${head} and ${last} have the same ${noun} (${formatted}).`;
  }
  return `"${leaders[0].name}" has the most ${noun} (${formatted}).`;
}

function recommendationFor(results: PackageComparisonEntry[]): string | undefined {
  const found = results.filter((entry) => entry.status === "found");
  const failed = results.filter((entry) => entry.status === "lookup-failed");
  const missing = results.filter((entry) => entry.status === "not-found");
  if (found.length === 0 && failed.length === 0) return undefined;

  const sentences: string[] = [];
  const downloadSentence = metricSentence(found, "weeklyDownloads", "weekly downloads");
  if (downloadSentence) sentences.push(downloadSentence);
  const starSentence = metricSentence(found, "githubStars", "GitHub stars");
  if (starSentence) sentences.push(starSentence);
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
        const message = error instanceof Error ? error.message : String(error);
        return { name: pkg, status: "lookup-failed", error: message };
      }
    })
  );

  const recommendation = recommendationFor(results);
  return {
    packages: results,
    ...(recommendation ? { recommendation } : {}),
  };
}
