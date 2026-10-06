/**
 * Analyze Package.json Tool
 *
 * Analyze a project's dependencies and provide recommendations.
 */
import semver from "semver";
import { fetchPackageData, fetchDownloads } from "./npm-client.js";
import { AdvisoryLookupError, checkSecurityAdvisories } from "./security-client.js";
async function analyzeDependency(name, versionSpec) {
    let securityError;
    const [npmData, downloads, advisories] = await Promise.all([
        fetchPackageData(name),
        fetchDownloads(name, "last-week"),
        checkSecurityAdvisories(name).catch((error) => {
            if (!(error instanceof AdvisoryLookupError))
                throw error;
            securityError = error.message;
            return [];
        }),
    ]);
    // Parse current version from spec (remove ^, ~, etc.)
    const currentVersion = versionSpec.replace(/^[\^~>=<]+/, "");
    if (!npmData) {
        return {
            name,
            current: currentVersion,
            status: "unknown",
            securityIssues: advisories.length,
            securityError,
            recommendation: "Package not found on npm",
        };
    }
    // Determine update status
    let status = "up-to-date";
    let recommendation;
    if (semver.valid(currentVersion) && semver.valid(npmData.version)) {
        const diff = semver.diff(currentVersion, npmData.version);
        if (diff === "major") {
            status = "major";
            recommendation = `Major update available: ${currentVersion} → ${npmData.version}. Check changelog for breaking changes.`;
        }
        else if (diff === "minor") {
            status = "minor";
            recommendation = `Minor update: ${currentVersion} → ${npmData.version}`;
        }
        else if (diff === "patch" || diff === "prepatch" || diff === "prerelease") {
            status = "patch";
            recommendation = `Patch update: ${currentVersion} → ${npmData.version}`;
        }
    }
    // Override with security recommendation if needed
    const criticalOrHigh = advisories.filter((a) => a.severity === "critical" || a.severity === "high");
    if (criticalOrHigh.length > 0) {
        recommendation = `⚠️ ${criticalOrHigh.length} security issue(s). Update immediately!`;
    }
    return {
        name,
        current: currentVersion,
        latest: npmData.version,
        status,
        securityIssues: advisories.length,
        securityError,
        weeklyDownloads: downloads?.downloads,
        recommendation,
    };
}
export async function analyzePackageJson(packageJson, checkDevDeps = true) {
    const deps = (packageJson.dependencies || {});
    const devDeps = checkDevDeps
        ? (packageJson.devDependencies || {})
        : {};
    // Analyze dependencies (limit to avoid rate limiting)
    const depEntries = Object.entries(deps).slice(0, 20);
    const devDepEntries = checkDevDeps
        ? Object.entries(devDeps).slice(0, 10)
        : [];
    const [depResults, devDepResults] = await Promise.all([
        Promise.all(depEntries.map(([name, version]) => analyzeDependency(name, version))),
        Promise.all(devDepEntries.map(([name, version]) => analyzeDependency(name, version))),
    ]);
    // Count issues
    const allResults = [...depResults, ...devDepResults];
    const outdatedCount = allResults.filter((r) => r.status !== "up-to-date" && r.status !== "unknown").length;
    const securityIssueCount = allResults.reduce((sum, r) => sum + r.securityIssues, 0);
    const securityErrorCount = allResults.filter((r) => r.securityError).length;
    // Identify top priorities
    const topPriorities = [];
    // Security issues first
    const withSecurity = allResults
        .filter((r) => r.securityIssues > 0)
        .sort((a, b) => b.securityIssues - a.securityIssues);
    for (const dep of withSecurity.slice(0, 3)) {
        topPriorities.push(`🔒 Update ${dep.name} - ${dep.securityIssues} security issue(s)`);
    }
    // Major updates
    const majorUpdates = allResults.filter((r) => r.status === "major");
    for (const dep of majorUpdates.slice(0, 2)) {
        if (!topPriorities.some((p) => p.includes(dep.name))) {
            topPriorities.push(`📦 ${dep.name}: major update ${dep.current} → ${dep.latest}`);
        }
    }
    // Generate summary
    let summary = `Analyzed ${allResults.length} dependencies. `;
    if (securityIssueCount > 0) {
        summary += `⚠️ ${securityIssueCount} security issues found. `;
    }
    if (outdatedCount > 0) {
        summary += `${outdatedCount} packages have updates available.`;
    }
    else {
        summary += "All packages up to date!";
    }
    if (securityErrorCount > 0) {
        summary += ` Security lookup failed for ${securityErrorCount} package(s).`;
    }
    return {
        totalDependencies: allResults.length,
        outdatedCount,
        securityIssueCount,
        dependencies: depResults,
        devDependencies: devDepResults.length > 0 ? devDepResults : undefined,
        summary,
        topPriorities,
    };
}
