/**
 * NPM Registry Client
 *
 * Fetches package data from the npm registry.
 */
const NPM_REGISTRY = "https://registry.npmjs.org";
export async function fetchPackageData(packageName) {
    try {
        const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}`);
        if (!response.ok) {
            if (response.status === 404)
                return null;
            throw new Error(`NPM API error: ${response.status}`);
        }
        const data = await response.json();
        return { ...data, version: data.version ?? data["dist-tags"]?.latest };
    }
    catch (error) {
        console.error(`Failed to fetch npm data for ${packageName}:`, error);
        return null;
    }
}
export async function fetchDownloads(packageName, period = "last-week") {
    try {
        const response = await fetch(`https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(packageName)}`);
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch (error) {
        console.error(`Failed to fetch downloads for ${packageName}:`, error);
        return null;
    }
}
