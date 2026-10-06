/**
 * Security Advisory Client
 *
 * Checks for security vulnerabilities using npm audit API and GitHub advisories.
 */
const GITHUB_ADVISORY_API = "https://api.github.com/advisories";
export class AdvisoryLookupError extends Error {
    constructor(message) {
        super(message);
        this.name = "AdvisoryLookupError";
    }
}
export async function checkSecurityAdvisories(packageName, version) {
    const advisories = [];
    // Check GitHub Security Advisories
    try {
        const headers = {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "ecosystem-mcp",
        };
        const token = process.env.GITHUB_TOKEN;
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        const affects = version ? `${packageName}@${version}` : packageName;
        let url = `${GITHUB_ADVISORY_API}?ecosystem=npm&per_page=100&affects=${encodeURIComponent(affects)}`;
        for (let page = 0; url && page < 10; page++) {
            const response = await fetch(url, { headers });
            if (!response.ok) {
                throw new AdvisoryLookupError(`GitHub advisory lookup failed for ${packageName}: HTTP ${response.status}`);
            }
            const data = await response.json().catch(() => null);
            if (!Array.isArray(data)) {
                throw new AdvisoryLookupError(`GitHub advisory lookup failed for ${packageName}: unexpected response body`);
            }
            for (const advisory of data) {
                const vulnerability = advisory.vulnerabilities?.find((entry) => entry.package?.name === packageName && entry.package.ecosystem === "npm");
                if (!vulnerability)
                    continue;
                advisories.push({
                    id: advisory.ghsa_id || advisory.id,
                    severity: (advisory.severity?.toLowerCase() || "moderate"),
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
        }
    }
    catch (error) {
        if (error instanceof AdvisoryLookupError)
            throw error;
        throw new AdvisoryLookupError(`GitHub advisory lookup failed for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return advisories;
}
