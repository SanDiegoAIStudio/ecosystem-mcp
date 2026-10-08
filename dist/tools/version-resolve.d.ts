/**
 * Decide which published version a dependency spec means.
 */
import type { NpmPackageData } from "./npm-client.js";
export type ResolvedVersion = {
    kind: "exact";
    version: string;
} | {
    kind: "latest";
    version: string;
} | {
    kind: "range";
    version: string;
    range: string;
} | {
    kind: "tag";
    version: string;
    tag: string;
} | {
    kind: "none";
    reason: string;
};
export declare function isRegistrySpec(spec: string): boolean;
export declare function versionResolutionSentence(resolved: Extract<ResolvedVersion, {
    kind: "range" | "tag";
}>): string;
export declare function resolveVersion(spec: string | undefined, pkg: NpmPackageData): ResolvedVersion;
