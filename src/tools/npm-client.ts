/**
 * NPM Registry Client
 *
 * Fetches package data from the npm registry.
 */

const NPM_REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 15_000;

export interface NpmPackageData {
  name: string;
  description?: string;
  version: string;
  license?: string;
  homepage?: string;
  repository?: { type?: string; url?: string } | string;
  keywords?: string[];
  types?: string;
  typings?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function repositoryUrl(
  repository: NpmPackageData["repository"]
): string | undefined {
  if (typeof repository === "string") {
    return repository;
  }
  if (repository && typeof repository.url === "string") {
    return repository.url;
  }
  return undefined;
}

function versionManifest(pkg: NpmPackageData): Record<string, unknown> | undefined {
  if (!isRecord(pkg.versions)) return undefined;
  const entry = pkg.versions[pkg.version];
  return isRecord(entry) ? entry : undefined;
}

function hasTypesField(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  return typeof record.types === "string" || typeof record.typings === "string";
}

function keywordsIncludeTypeScript(keywords: unknown): boolean {
  if (!Array.isArray(keywords)) return false;
  return keywords.some((keyword) => {
    if (typeof keyword !== "string") return false;
    const normalized = keyword.toLowerCase();
    return normalized === "typescript" || normalized === "types";
  });
}

function valueHasTypesKey(value: unknown, level: number): boolean {
  if (level > 6) return false;
  if (Array.isArray(value)) {
    return value.some((item) => valueHasTypesKey(item, level + 1));
  }
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "types" && typeof child === "string") return true;
    if (valueHasTypesKey(child, level + 1)) return true;
  }
  return false;
}

export class NpmLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpmLookupError";
  }
}

export function hasTypeScriptSupport(pkg: NpmPackageData): boolean {
  if (pkg.name.startsWith("@types/")) return true;
  const manifest = versionManifest(pkg);
  if (hasTypesField(manifest)) return true;
  if (typeof pkg.types === "string" || typeof pkg.typings === "string") return true;
  if (manifest && valueHasTypesKey(manifest.exports, 1)) return true;
  if (keywordsIncludeTypeScript(manifest?.keywords) || keywordsIncludeTypeScript(pkg.keywords)) {
    return true;
  }
  return false;
}

export function deprecationMessage(pkg: NpmPackageData): string | undefined {
  const deprecated = versionManifest(pkg)?.deprecated;
  if (typeof deprecated === "string" && deprecated.length > 0) return deprecated;
  return undefined;
}

function latestVersion(data: NpmPackageData): string | undefined {
  if (typeof data.version === "string" && data.version.length > 0) return data.version;
  const tagged = data["dist-tags"]?.latest;
  if (typeof tagged === "string" && tagged.length > 0) return tagged;
  return undefined;
}

export async function fetchPackageData(
  packageName: string
): Promise<NpmPackageData | null> {
  try {
    const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new NpmLookupError(
        `npm registry lookup failed for ${packageName}: HTTP ${response.status}`
      );
    }
    const data: NpmPackageData = await response.json();
    const version = latestVersion(data);
    if (!version) return null;
    return { ...data, version };
  } catch (error) {
    if (error instanceof NpmLookupError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new NpmLookupError(`npm registry lookup failed for ${packageName}: ${reason}`);
  }
}

export async function fetchDownloads(
  packageName: string,
  period: "last-week" | "last-month" | "last-year" = "last-week"
): Promise<NpmDownloads | null> {
  try {
    const response = await fetch(
      `https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(packageName)}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error(`Failed to fetch downloads for ${packageName}:`, error);
    return null;
  }
}
