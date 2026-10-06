/**
 * NPM Registry Client
 *
 * Fetches package data from the npm registry.
 */

const NPM_REGISTRY = "https://registry.npmjs.org";

export interface NpmPackageData {
  name: string;
  description?: string;
  version: string;
  license?: string;
  homepage?: string;
  repository?: { type: string; url: string };
  keywords?: string[];
  maintainers?: Array<{ name: string; email: string }>;
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

export async function fetchPackageData(
  packageName: string
): Promise<NpmPackageData | null> {
  try {
    const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}`);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`NPM API error: ${response.status}`);
    }
    const data: NpmPackageData = await response.json();
    return { ...data, version: data.version ?? data["dist-tags"]?.latest };
  } catch (error) {
    console.error(`Failed to fetch npm data for ${packageName}:`, error);
    return null;
  }
}

export async function fetchDownloads(
  packageName: string,
  period: "last-week" | "last-month" | "last-year" = "last-week"
): Promise<NpmDownloads | null> {
  try {
    const response = await fetch(
      `https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(packageName)}`
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error(`Failed to fetch downloads for ${packageName}:`, error);
    return null;
  }
}
