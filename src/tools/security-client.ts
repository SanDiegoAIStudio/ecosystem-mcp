/**
 * Security Advisory Client
 *
 * Checks for security vulnerabilities using the GitHub Security Advisories API.
 */

const GITHUB_ADVISORY_API = "https://api.github.com/advisories";

export class AdvisoryLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisoryLookupError";
  }
}

interface GitHubAdvisory {
  ghsa_id?: string;
  id: string;
  severity?: string;
  summary?: string;
  title?: string;
  description?: string;
  cve_id?: string;
  vulnerabilities?: Array<{
    package?: { name?: string; ecosystem?: string };
    patched_versions?: string;
    vulnerable_version_range?: string;
  }>;
  published_at?: string;
  html_url?: string;
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

function normalizeSeverity(value: string | undefined): SecurityAdvisory["severity"] {
  switch (value?.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "moderate";
    case "low":
      return "low";
    default:
      return "moderate";
  }
}

export async function checkSecurityAdvisories(
  packageName: string,
  version: string
): Promise<SecurityAdvisory[]> {
  const advisories: SecurityAdvisory[] = [];

  // Check GitHub Security Advisories
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "ecosystem-mcp",
    };

    const token = process.env.GITHUB_TOKEN;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const affects = `${packageName}@${version}`;
    let url: string | undefined =
      `${GITHUB_ADVISORY_API}?ecosystem=npm&per_page=100&affects=${encodeURIComponent(affects)}`;
    const requestInit: RequestInit = {
      headers,
      signal: AbortSignal.timeout(15_000),
    };

    for (let page = 0; url && page < 10; page++) {
      const response: Response = await fetch(url, requestInit);
      if (!response.ok) {
        const base = `GitHub advisory lookup failed for ${packageName}: HTTP ${response.status}`;
        const rateLimited = response.status === 403 || response.status === 429;
        throw new AdvisoryLookupError(
          rateLimited
            ? `${base}. GitHub's rate limit may be used up. Set GITHUB_TOKEN to raise it.`
            : base
        );
      }

      const data: GitHubAdvisory[] | null = await response.json().catch(() => null);
      if (!Array.isArray(data)) {
        throw new AdvisoryLookupError(
          `GitHub advisory lookup failed for ${packageName}: unexpected response body`
        );
      }

      for (const advisory of data) {
        const vulnerability = advisory.vulnerabilities?.find(
          (entry) => entry.package?.name === packageName && entry.package.ecosystem === "npm"
        );
        if (!vulnerability) continue;

        advisories.push({
          id: advisory.ghsa_id || advisory.id,
          severity: normalizeSeverity(advisory.severity),
          title: advisory.summary || advisory.title || "Unknown vulnerability",
          description: advisory.description,
          cve: advisory.cve_id,
          patchedVersions: vulnerability.patched_versions,
          vulnerableVersions: vulnerability.vulnerable_version_range,
          publishedAt: advisory.published_at,
          url: advisory.html_url,
        });
      }

      url = response.headers.get("link")
        ?.split(",")
        .find((link) => /;\s*rel="next"/.test(link))
        ?.match(/<([^>]+)>/)?.[1];
      if (!url?.startsWith("https://api.github.com/")) url = undefined;
    }

    if (url) {
      throw new AdvisoryLookupError(
        `GitHub advisory lookup failed for ${packageName}: more than 1,000 advisories, so the list is incomplete`
      );
    }
  } catch (error) {
    if (error instanceof AdvisoryLookupError) throw error;
    throw new AdvisoryLookupError(
      `GitHub advisory lookup failed for ${packageName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return advisories;
}
