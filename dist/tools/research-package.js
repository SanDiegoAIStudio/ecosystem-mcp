/**
 * Research Package Tool
 *
 * Deep dive on a specific npm package.
 */
import semver from "semver";
import { deprecationMessage, fetchDownloads, fetchPackageData, hasTypeScriptSupport, repositoryUrl, } from "./npm-client.js";
import { fetchRepoFromNpmUrl } from "./github-client.js";
import { AdvisoryLookupError, checkSecurityAdvisories } from "./security-client.js";
function readableVersion(input) {
    const exact = semver.valid(input);
    if (exact)
        return exact;
    if (semver.validRange(input) === null)
        return null;
    return semver.minVersion(input)?.version ?? null;
}
function stableVersionsAhead(versions, current) {
    let count = 0;
    for (const version of Object.keys(versions ?? {})) {
        if (semver.valid(version) === null)
            continue;
        if (semver.prerelease(version) !== null)
            continue;
        if (semver.gt(version, current))
            count += 1;
    }
    return count;
}
export async function researchPackage(packageName, currentVersion) {
    const npmData = await fetchPackageData(packageName);
    if (!npmData) {
        throw new Error(`Package "${packageName}" not found on npm`);
    }
    const readable = currentVersion ? readableVersion(currentVersion) : null;
    const checkedVersion = readable ?? npmData.version;
    let versionNote;
    let versionsBehind;
    if (currentVersion) {
        if (!readable) {
            versionNote = `The version "${currentVersion}" could not be compared.`;
        }
        else {
            versionsBehind = stableVersionsAhead(npmData.versions, readable);
        }
    }
    let securityError;
    let advisories = [];
    const [weeklyDownloads, monthlyDownloads, githubData] = await Promise.all([
        fetchDownloads(packageName, "last-week"),
        fetchDownloads(packageName, "last-month"),
        fetchRepoFromNpmUrl(repositoryUrl(npmData.repository)),
        checkSecurityAdvisories(packageName, checkedVersion).then((found) => {
            advisories = found;
        }, (error) => {
            if (!(error instanceof AdvisoryLookupError))
                throw error;
            securityError = error.message;
            advisories = [];
        }),
    ]);
    let daysSinceLastPublish;
    let lastPublish;
    if (npmData.time) {
        lastPublish = npmData.time[npmData.version];
        if (lastPublish) {
            const lastDate = new Date(lastPublish);
            daysSinceLastPublish = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
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
