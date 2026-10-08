/**
 * Check Security Tool
 *
 * Check for security advisories affecting a package.
 */
import { checkSecurityAdvisories } from "./security-client.js";
import { fetchPackageData } from "./npm-client.js";
import { resolveVersion, versionResolutionSentence } from "./version-resolve.js";
function recommendationFor(packageName, latestVersion, advisories, bySeverity, resolved) {
    const checkedVersion = resolved.version;
    const subject = `"${packageName}" ${checkedVersion}`;
    let sentence;
    if (advisories.length === 0) {
        sentence = `No known security advisories affect ${subject}.`;
    }
    else if (bySeverity.critical > 0) {
        const count = bySeverity.critical;
        sentence = count === 1
            ? `1 critical advisory affects ${subject}.`
            : `${count} critical advisories affect ${subject}.`;
    }
    else if (bySeverity.high > 0) {
        const count = bySeverity.high;
        sentence = count === 1
            ? `1 high severity advisory affects ${subject}.`
            : `${count} high severity advisories affect ${subject}.`;
    }
    else {
        const count = advisories.length;
        sentence = count === 1
            ? `1 advisory affects ${subject}.`
            : `${count} advisories affect ${subject}.`;
    }
    let text;
    if (checkedVersion === latestVersion) {
        text = `${sentence} That is the latest version.`;
    }
    else {
        text = `${sentence} Latest version: ${latestVersion}.`;
    }
    if (resolved.kind === "range" || resolved.kind === "tag") {
        text += ` ${versionResolutionSentence(resolved)}`;
    }
    return text;
}
export async function checkSecurity(packageName, version) {
    const npmData = await fetchPackageData(packageName);
    if (!npmData) {
        return {
            package: packageName,
            found: false,
            ...(version !== undefined ? { version } : {}),
            recommendation: `Package "${packageName}" was not found on npm, so no advisory lookup is meaningful.`,
        };
    }
    const resolved = resolveVersion(version, npmData);
    if (resolved.kind === "none")
        throw new Error(resolved.reason);
    const checkedVersion = resolved.version;
    const advisories = await checkSecurityAdvisories(packageName, checkedVersion);
    const bySeverity = {
        critical: advisories.filter((advisory) => advisory.severity === "critical").length,
        high: advisories.filter((advisory) => advisory.severity === "high").length,
        moderate: advisories.filter((advisory) => advisory.severity === "moderate").length,
        low: advisories.filter((advisory) => advisory.severity === "low").length,
    };
    return {
        package: packageName,
        found: true,
        version,
        checkedVersion,
        latestVersion: npmData.version,
        totalAdvisories: advisories.length,
        bySeverity,
        advisories,
        resolvedFrom: resolved.kind,
        recommendation: recommendationFor(packageName, npmData.version, advisories, bySeverity, resolved),
    };
}
