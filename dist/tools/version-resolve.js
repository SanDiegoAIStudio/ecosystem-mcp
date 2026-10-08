/**
 * Decide which published version a dependency spec means.
 */
import semver from "semver";
const NON_REGISTRY_PREFIX = /^(?:workspace:|npm:|file:|link:|git\+|git:|github:|gitlab:|bitbucket:|http:|https:)/i;
function isNpmGitHubShorthand(spec) {
    const hash = spec.indexOf("#");
    const head = hash === -1 ? spec : spec.slice(0, hash);
    if (head.startsWith("@") || /\s/.test(head))
        return false;
    const slash = head.indexOf("/");
    return slash > 0 && slash < head.length - 1 && head.indexOf("/", slash + 1) === -1;
}
export function isRegistrySpec(spec) {
    if (NON_REGISTRY_PREFIX.test(spec))
        return false;
    if (spec === "." ||
        spec === ".." ||
        spec.startsWith("./") ||
        spec.startsWith("../") ||
        spec.startsWith("/") ||
        spec.startsWith("~/")) {
        return false;
    }
    if (spec.includes("://"))
        return false;
    if (spec.startsWith("git@"))
        return false;
    if (isNpmGitHubShorthand(spec))
        return false;
    return true;
}
export function versionResolutionSentence(resolved) {
    if (resolved.kind === "range") {
        return `The range "${resolved.range}" was read as ${resolved.version}, the version a fresh install would get.`;
    }
    return `The tag "${resolved.tag}" points at ${resolved.version}.`;
}
export function resolveVersion(spec, pkg) {
    if (spec === undefined || spec === "" || spec === "*" || spec === "latest") {
        return { kind: "latest", version: pkg.version };
    }
    const exact = semver.valid(spec);
    if (exact)
        return { kind: "exact", version: exact };
    if (semver.validRange(spec) !== null) {
        const versionMap = pkg.versions;
        const published = Object.keys(versionMap ?? {});
        const taggedLatest = pkg["dist-tags"]?.latest;
        const latest = typeof taggedLatest === "string" && taggedLatest.length > 0 ? taggedLatest : pkg.version;
        const versionsMissingOrEmpty = versionMap == null || published.length === 0;
        const latestIsListed = versionMap != null && Object.hasOwn(versionMap, latest);
        if (semver.valid(latest) !== null &&
            semver.satisfies(latest, spec) &&
            (versionsMissingOrEmpty || latestIsListed)) {
            return { kind: "range", version: latest, range: spec };
        }
        const match = semver.maxSatisfying(published, spec);
        if (match)
            return { kind: "range", version: match, range: spec };
        return { kind: "none", reason: `No published version satisfies "${spec}".` };
    }
    const tags = pkg["dist-tags"];
    if (tags && Object.hasOwn(tags, spec)) {
        const tagged = tags[spec];
        if (typeof tagged === "string" && tagged.length > 0) {
            return { kind: "tag", version: tagged, tag: spec };
        }
    }
    return {
        kind: "none",
        reason: `"${spec}" is not a version, a range or a tag of this package.`,
    };
}
