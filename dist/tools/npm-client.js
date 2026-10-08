/**
 * NPM Registry Client
 *
 * Fetches package data from the npm registry.
 */
const NPM_REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 15_000;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function repositoryUrl(repository) {
    if (typeof repository === "string") {
        return repository;
    }
    if (repository && typeof repository.url === "string") {
        return repository.url;
    }
    return undefined;
}
function versionManifest(pkg) {
    if (!isRecord(pkg.versions))
        return undefined;
    const entry = pkg.versions[pkg.version];
    return isRecord(entry) ? entry : undefined;
}
function hasTypesField(record) {
    if (!record)
        return false;
    return typeof record.types === "string" || typeof record.typings === "string";
}
function keywordsIncludeTypeScript(keywords) {
    if (!Array.isArray(keywords))
        return false;
    return keywords.some((keyword) => {
        if (typeof keyword !== "string")
            return false;
        const normalized = keyword.toLowerCase();
        return normalized === "typescript" || normalized === "types";
    });
}
function valueHasTypesKey(value, level) {
    if (level > 6)
        return false;
    if (Array.isArray(value)) {
        return value.some((item) => valueHasTypesKey(item, level + 1));
    }
    if (!isRecord(value))
        return false;
    for (const [key, child] of Object.entries(value)) {
        if (key === "types" && typeof child === "string")
            return true;
        if (valueHasTypesKey(child, level + 1))
            return true;
    }
    return false;
}
export class NpmLookupError extends Error {
    constructor(message) {
        super(message);
        this.name = "NpmLookupError";
    }
}
export function hasTypeScriptSupport(pkg) {
    if (pkg.name.startsWith("@types/"))
        return true;
    const manifest = versionManifest(pkg);
    if (hasTypesField(manifest))
        return true;
    if (typeof pkg.types === "string" || typeof pkg.typings === "string")
        return true;
    if (manifest && valueHasTypesKey(manifest.exports, 1))
        return true;
    if (keywordsIncludeTypeScript(manifest?.keywords) || keywordsIncludeTypeScript(pkg.keywords)) {
        return true;
    }
    return false;
}
export function deprecationMessage(pkg) {
    const deprecated = versionManifest(pkg)?.deprecated;
    if (typeof deprecated === "string" && deprecated.length > 0)
        return deprecated;
    return undefined;
}
function latestVersion(data) {
    if (typeof data.version === "string" && data.version.length > 0)
        return data.version;
    const tagged = data["dist-tags"]?.latest;
    if (typeof tagged === "string" && tagged.length > 0)
        return tagged;
    return undefined;
}
export async function fetchPackageData(packageName) {
    try {
        const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            if (response.status === 404)
                return null;
            throw new NpmLookupError(`npm registry lookup failed for ${packageName}: HTTP ${response.status}`);
        }
        const data = await response.json();
        const version = latestVersion(data);
        if (!version)
            return null;
        return { ...data, version };
    }
    catch (error) {
        if (error instanceof NpmLookupError)
            throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new NpmLookupError(`npm registry lookup failed for ${packageName}: ${reason}`);
    }
}
export async function fetchDownloads(packageName, period = "last-week") {
    try {
        const response = await fetch(`https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(packageName)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch (error) {
        console.error(`Failed to fetch downloads for ${packageName}:`, error);
        return null;
    }
}
