/**
 * Analyze Package.json Tool
 *
 * Analyze a project's dependencies and provide recommendations.
 */
import semver from "semver";
import { deprecationMessage, fetchDownloads, fetchPackageData, NpmLookupError, } from "./npm-client.js";
import { AdvisoryLookupError, checkSecurityAdvisories } from "./security-client.js";
const DEPENDENCY_LIMIT = 20;
const DEV_DEPENDENCY_LIMIT = 10;
const LOOKUP_CONCURRENCY = 5;
const NON_RANGE_PREFIX = /^(?:workspace:|npm:|file:|link:|git\+|git:|github:|gitlab:|bitbucket:|http:|https:)/i;
function versionFromSpec(spec) {
    if (spec === "" || spec === "*" || spec === "latest")
        return null;
    if (NON_RANGE_PREFIX.test(spec))
        return null;
    const exact = semver.valid(spec);
    if (exact)
        return exact;
    if (semver.validRange(spec) === null)
        return null;
    return semver.minVersion(spec)?.version ?? null;
}
async function mapWithLimit(items, limit, fn) {
    if (items.length === 0)
        return [];
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        for (;;) {
            const current = nextIndex;
            if (current >= items.length)
                return;
            nextIndex = current + 1;
            results[current] = await fn(items[current]);
        }
    }
    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}
function deprecatedField(pkg) {
    if (!pkg)
        return {};
    const deprecated = deprecationMessage(pkg);
    return deprecated ? { deprecated } : {};
}
async function inspectDependency(name, versionSpec) {
    if (NON_RANGE_PREFIX.test(versionSpec)) {
        return {
            name,
            current: versionSpec,
            status: "unknown",
            securityIssues: null,
            recommendation: `Version spec "${versionSpec}" does not point at an npm registry version, so it was not looked up.`,
        };
    }
    const currentVersion = versionFromSpec(versionSpec);
    let npmData;
    let downloads;
    try {
        [npmData, downloads] = await Promise.all([
            fetchPackageData(name),
            fetchDownloads(name, "last-week"),
        ]);
    }
    catch (error) {
        if (error instanceof NpmLookupError) {
            return {
                name,
                current: versionSpec,
                status: "unknown",
                securityIssues: null,
                recommendation: error.message,
            };
        }
        throw error;
    }
    if (!currentVersion) {
        return {
            name,
            current: versionSpec,
            latest: npmData?.version,
            status: "unknown",
            securityIssues: null,
            weeklyDownloads: downloads?.downloads,
            recommendation: `Version spec "${versionSpec}" is not a plain version or range, so it was not compared and its advisories were not checked.`,
            ...deprecatedField(npmData),
        };
    }
    if (!npmData) {
        return {
            name,
            current: currentVersion,
            status: "unknown",
            securityIssues: null,
            recommendation: "Package not found on npm",
        };
    }
    let securityError;
    let securityIssues = null;
    let advisories = [];
    try {
        advisories = await checkSecurityAdvisories(name, currentVersion);
        securityIssues = advisories.length;
    }
    catch (error) {
        if (!(error instanceof AdvisoryLookupError))
            throw error;
        securityError = error.message;
        securityIssues = null;
    }
    let status = "up-to-date";
    let recommendation;
    if (semver.valid(currentVersion) && semver.valid(npmData.version)) {
        if (semver.lt(currentVersion, npmData.version)) {
            const diff = semver.diff(currentVersion, npmData.version);
            if (diff === "major" || diff === "premajor") {
                status = "major";
                recommendation = `Major update available: ${currentVersion} → ${npmData.version}. Check changelog for breaking changes.`;
            }
            else if (diff === "minor" || diff === "preminor") {
                status = "minor";
                recommendation = `Minor update: ${currentVersion} → ${npmData.version}`;
            }
            else if (diff === "patch" || diff === "prepatch" || diff === "prerelease") {
                status = "patch";
                recommendation = `Patch update: ${currentVersion} → ${npmData.version}`;
            }
        }
    }
    else {
        status = "unknown";
        recommendation = `The latest version on npm ("${npmData.version}") is not a version that can be compared.`;
    }
    const criticalOrHigh = advisories.filter((advisory) => advisory.severity === "critical" || advisory.severity === "high");
    if (criticalOrHigh.length > 0) {
        const count = criticalOrHigh.length;
        const sentence = count === 1
            ? `1 critical or high severity advisory affects ${name} ${currentVersion}.`
            : `${count} critical or high severity advisories affect ${name} ${currentVersion}.`;
        if (status === "patch" || status === "minor" || status === "major") {
            recommendation = `${sentence} Latest version: ${npmData.version}.`;
        }
        else {
            recommendation = sentence;
        }
    }
    return {
        name,
        current: currentVersion,
        latest: npmData.version,
        status,
        securityIssues,
        ...(securityError ? { securityError } : {}),
        weeklyDownloads: downloads?.downloads,
        recommendation,
        ...deprecatedField(npmData),
    };
}
async function analyzeDependency(name, versionSpec) {
    try {
        return await inspectDependency(name, versionSpec);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            name,
            current: versionSpec,
            status: "unknown",
            securityIssues: null,
            recommendation: message,
        };
    }
}
function buildSummary(allResults, limitNotes, securityIssueCount, outdatedCount, securityErrorCount) {
    if (allResults.length === 0)
        return "No dependencies to analyze.";
    const parts = [];
    if (limitNotes.length > 0)
        parts.push(...limitNotes);
    else
        parts.push(`Analyzed ${allResults.length} dependencies.`);
    if (securityIssueCount > 0) {
        parts.push(`Advisories affecting the versions in use: ${securityIssueCount}.`);
    }
    const listCut = limitNotes.length > 0;
    const allUpToDate = allResults.every((result) => result.status === "up-to-date");
    if (outdatedCount > 0) {
        parts.push(`${outdatedCount} packages have updates available.`);
    }
    else if (allUpToDate && listCut) {
        parts.push(`The ${allResults.length} analyzed are up to date.`);
    }
    else if (allUpToDate) {
        parts.push("All packages are up to date.");
    }
    const unknownCount = allResults.filter((result) => result.status === "unknown").length;
    if (unknownCount > 0)
        parts.push(`${unknownCount} could not be compared.`);
    const deprecatedCount = allResults.filter((result) => result.deprecated).length;
    if (deprecatedCount > 0)
        parts.push(`${deprecatedCount} deprecated.`);
    if (securityErrorCount > 0) {
        parts.push(`Security lookup failed for ${securityErrorCount} package(s).`);
    }
    const notChecked = allResults.filter((result) => result.securityIssues === null && !result.securityError).length;
    if (notChecked > 0) {
        parts.push(`Advisories were not checked for ${notChecked} package(s).`);
    }
    return parts.join(" ");
}
export async function analyzePackageJson(packageJson, checkDevDeps = true) {
    const deps = (packageJson.dependencies || {});
    const devDeps = checkDevDeps
        ? (packageJson.devDependencies || {})
        : {};
    const depTotal = Object.keys(deps).length;
    const devDepTotal = Object.keys(devDeps).length;
    const depEntries = Object.entries(deps).slice(0, DEPENDENCY_LIMIT);
    const devDepEntries = Object.entries(devDeps).slice(0, DEV_DEPENDENCY_LIMIT);
    const depResults = await mapWithLimit(depEntries, LOOKUP_CONCURRENCY, ([name, version]) => analyzeDependency(name, version));
    const devDepResults = await mapWithLimit(devDepEntries, LOOKUP_CONCURRENCY, ([name, version]) => analyzeDependency(name, version));
    const allResults = [...depResults, ...devDepResults];
    const outdatedCount = allResults.filter((result) => result.status !== "up-to-date" && result.status !== "unknown").length;
    const securityIssueCount = allResults.reduce((sum, result) => sum + (result.securityIssues ?? 0), 0);
    const securityErrorCount = allResults.filter((result) => result.securityError).length;
    const topPriorities = [];
    const withSecurity = allResults
        .filter((result) => (result.securityIssues ?? 0) > 0)
        .sort((a, b) => (b.securityIssues ?? 0) - (a.securityIssues ?? 0));
    for (const dep of withSecurity.slice(0, 3)) {
        const count = dep.securityIssues ?? 0;
        topPriorities.push(count === 1
            ? `${dep.name}: 1 advisory affects ${dep.current}`
            : `${dep.name}: ${count} advisories affect ${dep.current}`);
    }
    for (const dep of allResults) {
        if (dep.deprecated)
            topPriorities.push(`${dep.name} is deprecated on npm`);
    }
    const majorUpdates = allResults.filter((result) => result.status === "major");
    for (const dep of majorUpdates.slice(0, 2)) {
        if (!topPriorities.some((line) => line.includes(dep.name))) {
            topPriorities.push(`${dep.name}: major update ${dep.current} to ${dep.latest}`);
        }
    }
    const analyzedCounts = {};
    const limitNotes = [];
    if (depTotal > DEPENDENCY_LIMIT) {
        analyzedCounts.dependencies = { analyzed: depResults.length, total: depTotal };
        limitNotes.push(`Analyzed the first ${depResults.length} of ${depTotal} dependencies.`);
    }
    if (devDepTotal > DEV_DEPENDENCY_LIMIT) {
        analyzedCounts.devDependencies = { analyzed: devDepResults.length, total: devDepTotal };
        limitNotes.push(`Analyzed the first ${devDepResults.length} of ${devDepTotal} devDependencies.`);
    }
    return {
        totalDependencies: depTotal + devDepTotal,
        analyzedDependencies: allResults.length,
        outdatedCount,
        securityIssueCount,
        dependencies: depResults,
        devDependencies: devDepResults.length > 0 ? devDepResults : undefined,
        summary: buildSummary(allResults, limitNotes, securityIssueCount, outdatedCount, securityErrorCount),
        topPriorities,
        ...(Object.keys(analyzedCounts).length > 0 ? { analyzedCounts } : {}),
    };
}
