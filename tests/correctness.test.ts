import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, mock, test } from "bun:test";
import { analyzePackageJson } from "../src/tools/analyze-package-json.js";
import { checkSecurity } from "../src/tools/check-security.js";
import { comparePackages } from "../src/tools/compare-packages.js";
import { ExaDeepClient } from "../src/tools/exa-deep.js";
import { alternativeNotes, findAlternatives, type AlternativesResult } from "../src/tools/find-alternatives.js";
import { fetchRepo, parseGitHubRepo } from "../src/tools/github-client.js";
import { getTrending } from "../src/tools/get-trending.js";
import {
  fetchDownloads,
  fetchPackageData,
  hasTypeScriptSupport,
  NpmLookupError,
} from "../src/tools/npm-client.js";
import { researchPackage } from "../src/tools/research-package.js";
import { AdvisoryLookupError, checkSecurityAdvisories } from "../src/tools/security-client.js";
import { cliEntryMatches, handleToolCall, tools } from "../src/index.js";
import { isRegistrySpec, resolveVersion } from "../src/tools/version-resolve.js";

type Fixture = {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
} | Error | Response;

const originalFetch = globalThis.fetch;
let unexpectedRequests: string[] = [];

function mockFetch(
  fixtures: Record<string, Fixture>,
  observer?: {
    delayMs?: number;
    onStart?: (url: string) => void;
    onEnd?: (url: string) => void;
  }
) {
  const fetchMock = mock(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    observer?.onStart?.(url);
    try {
      if (observer?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, observer.delayMs));
      }
      const fixture = fixtures[url];
      if (!fixture) {
        unexpectedRequests.push(url);
        throw new Error(`Unexpected fetch: ${url}`);
      }
      if (fixture instanceof Error) throw fixture;
      if (fixture instanceof Response) return fixture.clone();
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.status ?? 200,
        headers: fixture.headers,
      });
    } finally {
      observer?.onEnd?.(url);
    }
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  const unexpected = unexpectedRequests;
  unexpectedRequests = [];
  expect(unexpected).toEqual([]);
});

function dependencyFixtures(
  name: string,
  latest: string,
  advisoryVersion?: string
): Record<string, Fixture> {
  const encoded = encodeURIComponent(name);
  const affects = advisoryVersion ? `${name}@${advisoryVersion}` : name;
  return {
    [`https://registry.npmjs.org/${encoded}`]: {
      body: { name, version: latest, "dist-tags": { latest } },
    },
    [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: {
      body: { downloads: 10, package: name },
    },
    [`https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=${encodeURIComponent(affects)}`]: {
      body: [],
    },
  };
}

function registryDownloads(name: string, latest: string, downloads = 10): Record<string, Fixture> {
  const encoded = encodeURIComponent(name);
  return {
    [`https://registry.npmjs.org/${encoded}`]: {
      body: { name, version: latest, "dist-tags": { latest } },
    },
    [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: {
      body: { downloads, package: name },
    },
  };
}

function packageBundle(
  name: string,
  body: Record<string, unknown>,
  downloads?: number
): Record<string, Fixture> {
  const encoded = encodeURIComponent(name);
  return {
    [`https://registry.npmjs.org/${encoded}`]: { body },
    [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: downloads === undefined
      ? { status: 404, body: {} }
      : { body: { downloads, package: name } },
  };
}

test('check_security on a missing package does not say there are no known security advisories', async () => {
  // source: a package that does not exist was reported as having no known security advisories.
  mockFetch({
    "https://registry.npmjs.org/missing-pkg": { status: 404, body: {} },
  });

  const result = await checkSecurity("missing-pkg");
  expect(result.found).toBe(false);
  expect(result.recommendation).toBe(
    'Package "missing-pkg" was not found on npm, so no advisory lookup is meaningful.'
  );
  expect(JSON.stringify(result)).not.toContain("No known security advisories");
});

test("check_security on a found package with no advisories says there are no known security advisories", async () => {
  // source: a package that exists and has zero advisories keeps the no-advisories sentence.
  mockFetch({
    "https://registry.npmjs.org/lodash": {
      body: { name: "lodash", "dist-tags": { latest: "4.17.21" } },
    },
    "https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=lodash%404.17.21": { body: [] },
  });

  const result = await checkSecurity("lodash");
  expect(result.found).toBe(true);
  expect(result.checkedVersion).toBe("4.17.21");
  expect(result.recommendation).toBe(
    'No known security advisories affect "lodash" 4.17.21. That is the latest version.'
  );
});

test('analyze_package_json does not treat a range with no published match as up to date', async () => {
  // source: a range was checked at its floor, so "^1.2.0" became 1.2.0 even when the versions map had no match.
  mockFetch({
    ...dependencyFixtures("a", "1.5.0", "1.2.0"),
    "https://registry.npmjs.org/a": {
      body: {
        name: "a",
        version: "1.5.0",
        "dist-tags": { latest: "1.5.0" },
        versions: { "1.0.0": {} },
      },
    },
    ...registryDownloads("b", "9.0.0"),
    [affectUrl("b", "9.0.0")]: { body: [] },
    ...dependencyFixtures("d", "1.0.0", "1.0.0"),
  });

  const result = await analyzePackageJson({
    dependencies: { a: "^1.2.0", b: "latest", c: "workspace:*", d: "1.0.0" },
  });
  expect(result.dependencies).toMatchObject([
    {
      name: "a",
      spec: "^1.2.0",
      current: "^1.2.0",
      status: "unknown",
      resolvedFrom: "none",
      securityIssues: null,
      recommendation: 'No published version satisfies "^1.2.0".',
    },
    {
      name: "b",
      spec: "latest",
      current: "9.0.0",
      latest: "9.0.0",
      status: "up-to-date",
      resolvedFrom: "latest",
      securityIssues: 0,
    },
    {
      name: "c",
      spec: "workspace:*",
      status: "unknown",
      securityIssues: null,
      recommendation: 'Version spec "workspace:*" does not point at an npm registry version, so it was not looked up.',
    },
    { name: "d", spec: "1.0.0", current: "1.0.0", latest: "1.0.0", status: "up-to-date" },
  ]);
  expect(result.dependencies.find((dep) => dep.name === "d")?.resolvedFrom).toBeUndefined();
  expect(result.summary).not.toContain("All packages are up to date.");
  expect(result.summary).toContain(
    "Ranges and tags were read as a fresh install would resolve them. A lockfile may hold an older version."
  );
});

test("star and empty specs resolve to latest, and protocol specs are not looked up", async () => {
  // source: * and an empty spec were left unknown, and npm/git/http/file/link specs were compared as if they were versions.
  const specs: Record<string, string> = {
    star: "*",
    blank: "",
    filedep: "file:../local",
    npmalias: "npm:left-pad@1.0.0",
    gitdep: "git+https://github.com/acme/pkg.git",
    httpdep: "https://example.com/pkg.tgz",
    linkdep: "link:../pkg",
  };
  const fixtures: Record<string, Fixture> = {};
  for (const name of ["star", "blank"]) {
    Object.assign(fixtures, dependencyFixtures(name, "1.0.0", "1.0.0"));
  }
  mockFetch(fixtures);

  const result = await analyzePackageJson({ dependencies: specs });
  const latestSpecs = new Set(["star", "blank"]);
  for (const dep of result.dependencies) {
    if (latestSpecs.has(dep.name)) {
      expect(dep.status).toBe("up-to-date");
      expect(dep.current).toBe("1.0.0");
      expect(dep.spec).toBe(specs[dep.name]);
      expect(dep.resolvedFrom).toBe("latest");
      expect(dep.securityIssues).toBe(0);
    } else {
      expect(dep.status).toBe("unknown");
      expect(dep.recommendation).toBe(
        `Version spec "${specs[dep.name]}" does not point at an npm registry version, so it was not looked up.`
      );
    }
  }
  expect(result.summary).not.toContain("All packages are up to date.");
});

test("a dependency newer than npm latest is up to date, and premajor counts as major", async () => {
  // source: a newer installed version was called a major update, and premajor or preminor diffs were ignored.
  mockFetch({
    ...dependencyFixtures("newer", "1.5.0", "2.0.0"),
    ...dependencyFixtures("pre", "2.0.0-beta.1", "1.0.0"),
    ...dependencyFixtures("preminor", "1.1.0-beta.1", "1.0.0"),
  });

  const result = await analyzePackageJson({
    dependencies: { newer: "2.0.0", pre: "1.0.0", preminor: "1.0.0" },
  });
  expect(result.dependencies).toMatchObject([
    { name: "newer", status: "up-to-date" },
    { name: "pre", status: "major" },
    { name: "preminor", status: "minor" },
  ]);
});

test("hyphen, space, and x-ranges use the newest published match", async () => {
  // source: hyphen, space, and x-ranges were checked at semver.minVersion, the oldest version the range allows.
  function withVersions(name: string, latest: string, versions: string[], advisory: string): Record<string, Fixture> {
    return {
      [`https://registry.npmjs.org/${name}`]: {
        body: {
          name,
          version: latest,
          "dist-tags": { latest },
          versions: Object.fromEntries(versions.map((version) => [version, {}])),
        },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${name}`]: {
        body: { downloads: 10, package: name },
      },
      [affectUrl(name, advisory)]: { body: [] },
    };
  }
  mockFetch({
    ...withVersions("hyphen", "2.1.0", ["1.2.3", "2.0.0", "2.1.0"], "2.0.0"),
    ...withVersions("space", "1.9.0", ["1.2.3", "1.9.0"], "1.9.0"),
    ...withVersions("xrange", "1.5.0", ["1.0.0", "1.5.0"], "1.5.0"),
  });

  const result = await analyzePackageJson({
    dependencies: {
      hyphen: "1.2.3 - 2.0.0",
      space: ">=1.2.3 <2.0.0",
      xrange: "1.x",
    },
  });
  expect(result.dependencies).toMatchObject([
    { name: "hyphen", current: "2.0.0", spec: "1.2.3 - 2.0.0", resolvedFrom: "range", status: "minor" },
    { name: "space", current: "1.9.0", spec: ">=1.2.3 <2.0.0", resolvedFrom: "range", status: "up-to-date" },
    { name: "xrange", current: "1.5.0", spec: "1.x", resolvedFrom: "range", status: "up-to-date" },
  ]);
});

test("a dependency whose registry fetch rejects becomes unknown while the others are analyzed", async () => {
  // source: one failed registry lookup failed the whole package.json analysis.
  mockFetch({
    "https://registry.npmjs.org/bad": new Error("registry down"),
    "https://api.npmjs.org/downloads/point/last-week/bad": { body: { downloads: 1, package: "bad" } },
    "https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=bad%402.0.0": { body: [] },
    ...dependencyFixtures("good", "1.0.0", "1.0.0"),
  });

  let rejection: unknown = null;
  let result: Awaited<ReturnType<typeof analyzePackageJson>> | undefined;
  try {
    result = await analyzePackageJson({
      dependencies: { good: "1.0.0", bad: "2.0.0" },
    });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeNull();
  const good = result?.dependencies.find((dep) => dep.name === "good");
  const bad = result?.dependencies.find((dep) => dep.name === "bad");
  expect(good).toMatchObject({ status: "up-to-date", latest: "1.0.0" });
  expect(bad?.status).toBe("unknown");
  expect(result?.dependencies).toHaveLength(2);
});

test("25 dependencies give analyzed 20 of 25", async () => {
  // source: analyzing more than 20 dependencies hid the fact that later ones were skipped.
  const dependencies: Record<string, string> = {};
  const fixtures: Record<string, Fixture> = {};
  for (let index = 0; index < 25; index += 1) {
    const name = `dep${index}`;
    dependencies[name] = "1.2.0";
    Object.assign(fixtures, dependencyFixtures(name, "1.2.0", "1.2.0"));
  }
  const fetchMock = mockFetch(fixtures);

  const result = await analyzePackageJson({ dependencies });
  expect(result.analyzedCounts?.dependencies).toEqual({ analyzed: 20, total: 25 });
  expect(result.summary).toContain("Analyzed the first 20 of 25 dependencies");
  expect(result.dependencies).toHaveLength(20);
  const registryCalls = fetchMock.mock.calls.filter(([url]) =>
    String(url).startsWith("https://registry.npmjs.org/")
  );
  expect(registryCalls).toHaveLength(20);
});

test("more than 10 devDependencies are reported as the first 10 of the total", async () => {
  // source: devDependencies past the first 10 were dropped without saying so.
  const devDependencies: Record<string, string> = {};
  const fixtures: Record<string, Fixture> = {};
  for (let index = 0; index < 12; index += 1) {
    const name = `dev${index}`;
    devDependencies[name] = "1.0.0";
    Object.assign(fixtures, dependencyFixtures(name, "1.0.0", "1.0.0"));
  }
  mockFetch(fixtures);

  const result = await analyzePackageJson({ dependencies: {}, devDependencies });
  expect(result.analyzedCounts?.devDependencies).toEqual({ analyzed: 10, total: 12 });
  expect(result.summary).toContain("Analyzed the first 10 of 12 devDependencies");
  expect(result.devDependencies).toHaveLength(10);
});

test("no more than 5 registry requests are in flight at once", async () => {
  // source: every dependency was looked up at once.
  const dependencies: Record<string, string> = {};
  const fixtures: Record<string, Fixture> = {};
  for (let index = 0; index < 12; index += 1) {
    const name = `pool${index}`;
    dependencies[name] = "1.0.0";
    Object.assign(fixtures, dependencyFixtures(name, "1.0.0", "1.0.0"));
  }
  let inFlight = 0;
  let maxInFlight = 0;
  mockFetch(fixtures, {
    delayMs: 30,
    onStart(url) {
      if (!url.startsWith("https://registry.npmjs.org/")) return;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    },
    onEnd(url) {
      if (!url.startsWith("https://registry.npmjs.org/")) return;
      inFlight -= 1;
    },
  });

  await analyzePackageJson({ dependencies });
  expect(maxInFlight).toBeGreaterThan(1);
  expect(maxInFlight).toBeLessThanOrEqual(5);
});

test("compare_packages reads types from the latest manifest, prints unknown for missing downloads and stars, and still answers when the GitHub fetch rejects", async () => {
  // source: TypeScript support ignored the latest manifest types field, and missing downloads or stars printed as undefined. A rejected GitHub lookup failed the comparison.
  mockFetch({
    ...packageBundle("typed-lib", {
      name: "typed-lib",
      version: "2.0.0",
      versions: { "2.0.0": { types: "./index.d.ts" } },
      repository: { type: "git", url: "git+https://github.com/acme/typed-lib.git" },
    }),
    "https://api.github.com/repos/acme/typed-lib": new Error("github down"),
    ...packageBundle("plain-lib", {
      name: "plain-lib",
      version: "1.0.0",
      versions: { "1.0.0": {} },
    }),
  });

  const result = await comparePackages(["typed-lib", "plain-lib"]);
  const typed = result.packages.find((pkg) => pkg.name === "typed-lib");
  const plain = result.packages.find((pkg) => pkg.name === "plain-lib");
  expect(typed?.typescript).toBe(true);
  expect(typed?.status).toBe("found");
  expect(typed?.githubStars).toBeUndefined();
  expect(plain?.typescript).toBe(false);
  expect(plain?.weeklyDownloads).toBeUndefined();
  expect(result.recommendation).toBe(
    "Weekly downloads were not available for: typed-lib, plain-lib. GitHub stars were not available for: typed-lib, plain-lib."
  );
  expect(result.recommendation).not.toContain("undefined");
});

test("a string repository reaches the GitHub lookup", async () => {
  // source: a repository string was ignored because only repository.url was read.
  const fetchMock = mockFetch({
    ...packageBundle("string-lib", {
      name: "string-lib",
      version: "1.0.0",
      versions: { "1.0.0": {} },
      repository: "git+https://github.com/acme/string-lib.git",
    }, 50),
    "https://api.github.com/repos/acme/string-lib": {
      body: {
        name: "string-lib",
        full_name: "acme/string-lib",
        description: null,
        stargazers_count: 42,
        forks_count: 1,
        open_issues_count: 0,
        license: null,
        pushed_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        archived: false,
        disabled: false,
      },
    },
    ...packageBundle("other-lib", {
      name: "other-lib",
      version: "1.0.0",
      versions: { "1.0.0": {} },
    }, 10),
  });

  const result = await comparePackages(["string-lib", "other-lib"]);
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toContain("https://api.github.com/repos/acme/string-lib");
  expect(result.packages.find((pkg) => pkg.name === "string-lib")?.githubStars).toBe(42);
});

test('research_package with currentVersion "^1.2.3" and with "latest" does not throw', async () => {
  // source: semver.eq threw on a range or tag, so the research lookup failed.
  const registry = {
    "https://registry.npmjs.org/zod": {
      body: {
        name: "zod",
        version: "4.0.0",
        "dist-tags": { latest: "4.0.0" },
        versions: {
          "1.2.3": {},
          "4.0.0": { types: "./index.d.ts" },
        },
      },
    },
    "https://api.npmjs.org/downloads/point/last-week/zod": { body: { downloads: 10, package: "zod" } },
    "https://api.npmjs.org/downloads/point/last-month/zod": { body: { downloads: 40, package: "zod" } },
    [`https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=${encodeURIComponent("zod@1.2.3")}`]: {
      body: [],
    },
    [`https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=${encodeURIComponent("zod@4.0.0")}`]: {
      body: [],
    },
  };
  mockFetch(registry);

  const ranged = await researchPackage("zod", "^1.2.3");
  expect(ranged.latestVersion).toBe("4.0.0");
  expect(ranged.versionNote).toBe(
    'The range "^1.2.3" was read as 1.2.3, the version a fresh install would get.'
  );
  expect(ranged.typescript).toBe(true);
  expect(ranged.versionsBehind).toBe(1);

  const tagged = await researchPackage("zod", "latest");
  expect(tagged.versionNote).toBeUndefined();
  expect(tagged.security.checkedVersion).toBe("4.0.0");
  expect(tagged.versionsBehind).toBe(0);
});

test("get_trending loads every curated animation package", async () => {
  // source: a framework argument filtered the curated list even though the list has no framework data.
  function trendingBundle(name: string, weekly: number): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" }, description: name },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: {
        body: { downloads: weekly, package: name },
      },
      [`https://api.npmjs.org/downloads/point/last-month/${encoded}`]: {
        body: { downloads: weekly * 4, package: name },
      },
    };
  }
  const names = ["framer-motion", "react-spring", "@react-spring/web", "gsap", "animejs", "motion"];
  const fixtures: Record<string, Fixture> = {};
  names.forEach((name, index) => Object.assign(fixtures, trendingBundle(name, (index + 1) * 10)));
  const fetchMock = mockFetch(fixtures);

  const result = await getTrending("animation");
  expect(result.packages.map((pkg) => pkg.name).sort()).toEqual([...names].sort());
  expect(result.notLoaded).toEqual([]);
  expect("framework" in result).toBe(false);
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("gsap"))).toBe(true);
  expect(urls.some((url) => url.includes("framer-motion"))).toBe(true);
});

test('find_alternatives("constructor") returns no curated alternatives, and Moment matches moment', async () => {
  // source: constructor crashed on a prototype lookup, and Moment did not match the moment migration effort.
  mockFetch({});
  const missing = await findAlternatives("constructor");
  expect(missing.alternatives).toEqual([]);
  expect(missing.notLoaded).toEqual([]);
  expect(missing.recommendation).toBe(
    'No curated alternatives found for "constructor". Consider searching npm for similar packages.'
  );
  expect((await findAlternatives("toString")).recommendation).toContain("No curated alternatives");

  function altBundle(name: string, downloads: number): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" }, description: name },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: {
        body: { downloads, package: name },
      },
    };
  }
  mockFetch({
    ...altBundle("date-fns", 300),
    ...altBundle("dayjs", 200),
    ...altBundle("luxon", 100),
    ...altBundle("vite", 400),
    ...altBundle("esbuild", 50),
    ...altBundle("rollup", 40),
    ...altBundle("parcel", 30),
  });

  const lower = await findAlternatives("moment");
  const upper = await findAlternatives("Moment");
  const effort = (result: AlternativesResult, name: string) =>
    result.alternatives.find((item) => item.name === name)?.migrationEffort;
  expect(effort(upper, "dayjs")).toBe("low");
  expect(effort(upper, "dayjs")).toBe(effort(lower, "dayjs"));
  expect(effort(upper, "date-fns")).toBe(effort(lower, "date-fns"));
  expect(effort(upper, "luxon")).toBe(effort(lower, "luxon"));
  expect(lower.alternatives.find((item) => item.name === "dayjs")?.cons).toEqual([
    "Time zones and several formats need plugins",
  ]);
  expect(lower.alternatives.find((item) => item.name === "luxon")?.pros).toEqual([]);
  expect(lower.alternatives.find((item) => item.name === "luxon")?.cons).toEqual([]);

  const webpack = await findAlternatives("webpack");
  const vite = webpack.alternatives.find((item) => item.name === "vite");
  expect(vite?.pros).toEqual([
    "Dev server serves native ES modules",
    "Hot module replacement",
    "Works with little configuration",
  ]);
  expect(vite?.pros).not.toContain("Lightning fast HMR");
  expect(JSON.stringify(vite)).not.toContain("Popular choice");
});

test("calling each tool handler with missing or wrong-typed arguments returns Invalid arguments", async () => {
  // source: missing or wrong-typed tool arguments escaped as a TypeError.
  const cases: Array<{ name: string; arguments: unknown; field: string }> = [
    { name: "research_package", arguments: {}, field: "package" },
    { name: "research_package", arguments: { package: 1 }, field: "package" },
    { name: "compare_packages", arguments: {}, field: "packages" },
    { name: "compare_packages", arguments: { packages: "react" }, field: "packages" },
    { name: "compare_packages", arguments: { packages: ["only-one"] }, field: "packages" },
    { name: "find_alternatives", arguments: {}, field: "package" },
    { name: "find_alternatives", arguments: { package: 1 }, field: "package" },
    { name: "check_security", arguments: {}, field: "package" },
    { name: "check_security", arguments: { package: "" }, field: "package" },
    { name: "analyze_package_json", arguments: {}, field: "packageJson" },
    { name: "analyze_package_json", arguments: { packageJson: "nope" }, field: "packageJson" },
    {
      name: "analyze_package_json",
      arguments: { packageJson: { dependencies: { a: 1 } } },
      field: "packageJson.dependencies.a",
    },
    { name: "analyze_package_json", arguments: { packageJson: {}, checkDevDeps: "yes" }, field: "checkDevDeps" },
    { name: "exa_deep_search", arguments: {}, field: "query" },
    { name: "exa_deep_search", arguments: { query: 1 }, field: "query" },
    { name: "exa_research", arguments: {}, field: "instructions" },
    { name: "exa_research", arguments: { instructions: 1 }, field: "instructions" },
    { name: "get_trending", arguments: {}, field: "category" },
    { name: "get_trending", arguments: { category: 1 }, field: "category" },
  ];

  for (const toolCase of cases) {
    const result = await handleToolCall({
      params: { name: toolCase.name, arguments: toolCase.arguments },
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith(`Invalid arguments for ${toolCase.name}:`)).toBe(true);
    expect(text).toContain(toolCase.field);
  }
});

function affectUrl(name: string, version: string): string {
  return `https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=${encodeURIComponent(`${name}@${version}`)}`;
}

function registryLatest(name: string, latest: string): Record<string, Fixture> {
  return {
    [`https://registry.npmjs.org/${encodeURIComponent(name)}`]: {
      body: { name, version: latest, "dist-tags": { latest } },
    },
  };
}

function ghsa(packageName: string, id: string, severity: string) {
  return {
    ghsa_id: id,
    severity,
    summary: `${severity} issue`,
    vulnerabilities: [{
      package: { name: packageName, ecosystem: "npm" },
      vulnerable_version_range: "< 9.9.9",
      patched_versions: ">= 9.9.9",
    }],
  };
}

test("fetchPackageData returns null only when the package is missing", async () => {
  // source: a registry timeout or a 500 made check_security say the package was not found on npm.
  mockFetch({ "https://registry.npmjs.org/pkg": { status: 500, body: {} } });
  const httpError = await fetchPackageData("pkg").catch((error: unknown) => error);
  expect(httpError).toBeInstanceOf(NpmLookupError);
  expect(httpError).toMatchObject({ message: "npm registry lookup failed for pkg: HTTP 500" });

  mockFetch({ "https://registry.npmjs.org/pkg": new Error("socket hang up") });
  const networkError = await fetchPackageData("pkg").catch((error: unknown) => error);
  expect(networkError).toBeInstanceOf(NpmLookupError);
  expect(networkError).toMatchObject({ message: "npm registry lookup failed for pkg: socket hang up" });

  mockFetch({ "https://registry.npmjs.org/pkg": { status: 404, body: {} } });
  expect(await fetchPackageData("pkg")).toBeNull();

  mockFetch({
    "https://registry.npmjs.org/pkg": { body: { name: "pkg" } },
  });
  expect(await fetchPackageData("pkg")).toBeNull();
});

test("check_security on a registry 500 rejects instead of reporting not found", async () => {
  // source: a registry 500 was reported as the package was not found on npm.
  mockFetch({ "https://registry.npmjs.org/lodash": { status: 500, body: {} } });
  const outcome = await checkSecurity("lodash").then(
    (result) => ({ returned: true as const, result }),
    (error: unknown) => ({ returned: false as const, error })
  );
  expect(outcome.returned).toBe(false);
  if (!outcome.returned) {
    expect(outcome.error).toBeInstanceOf(NpmLookupError);
    expect(outcome.error).not.toMatchObject({ found: false });
  }
});

test("check_security asks for one concrete version", async () => {
  // source: with no version the advisory lookup returned every advisory, and a range was sent as a version.
  const latest = "4.17.21";
  let fetchMock = mockFetch({
    ...registryLatest("lodash", latest),
    [affectUrl("lodash", latest)]: { body: [] },
  });
  const omitted = await checkSecurity("lodash");
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("lodash", latest)
  );
  expect(omitted.checkedVersion).toBe(latest);
  expect(omitted.version).toBeUndefined();
  expect(omitted.recommendation?.endsWith("That is the latest version.")).toBe(true);

  fetchMock = mockFetch({
    "https://registry.npmjs.org/lodash": {
      body: {
        name: "lodash",
        version: latest,
        "dist-tags": { latest },
        versions: { "4.17.0": {}, "4.17.15": {}, "4.17.21": {}, "5.0.0-beta.1": {} },
      },
    },
    [affectUrl("lodash", latest)]: { body: [] },
  });
  const ranged = await checkSecurity("lodash", "^4.17.0");
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("lodash", latest)
  );
  expect(ranged.checkedVersion).toBe(latest);
  expect(ranged.resolvedFrom).toBe("range");
  expect(ranged.version).toBe("^4.17.0");

  fetchMock = mockFetch({
    ...registryLatest("lodash", latest),
    [affectUrl("lodash", latest)]: { body: [] },
  });
  let rejection: unknown = null;
  let tagged: Awaited<ReturnType<typeof checkSecurity>> | undefined;
  try {
    tagged = await checkSecurity("lodash", "latest");
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeNull();
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("lodash", latest)
  );
  expect(tagged?.checkedVersion).toBe(latest);

  mockFetch(registryLatest("lodash", latest));
  const badVersion = await checkSecurity("lodash", "banana").catch((error: unknown) => error);
  expect(badVersion).toBeInstanceOf(Error);
  expect((badVersion as Error).message).toBe(
    '"banana" is not a version, a range or a tag of this package.'
  );
});

test("check_security recommendation sentences name the version and the severity", async () => {
  // source: recommendation text used an exclamation and did not say which version was checked.
  async function sentence(advisories: unknown[]): Promise<string> {
    mockFetch({
      ...registryLatest("widget", "1.2.3"),
      [affectUrl("widget", "1.2.3")]: { body: advisories },
    });
    const result = await checkSecurity("widget");
    return result.recommendation ?? "";
  }

  expect(await sentence([])).toBe(
    'No known security advisories affect "widget" 1.2.3. That is the latest version.'
  );
  expect(await sentence([ghsa("widget", "GHSA-c1", "critical")])).toBe(
    '1 critical advisory affects "widget" 1.2.3. That is the latest version.'
  );
  expect(await sentence([
    ghsa("widget", "GHSA-c1", "critical"),
    ghsa("widget", "GHSA-c2", "critical"),
  ])).toBe('2 critical advisories affect "widget" 1.2.3. That is the latest version.');
  expect(await sentence([ghsa("widget", "GHSA-h1", "high")])).toBe(
    '1 high severity advisory affects "widget" 1.2.3. That is the latest version.'
  );
  expect(await sentence([ghsa("widget", "GHSA-m1", "moderate")])).toBe(
    '1 advisory affects "widget" 1.2.3. That is the latest version.'
  );
});

test("research_package asks for one version and does not count a failed lookup as zero", async () => {
  // source: a range was sent to the advisory API, and a failed lookup was reported as zero advisories.
  function zodBundle(advisoryVersion: string, status = 200): Record<string, Fixture> {
    return {
      "https://registry.npmjs.org/zod": {
        body: {
          name: "zod",
          version: "4.0.0",
          "dist-tags": { latest: "4.0.0" },
          versions: { "1.2.3": {}, "4.0.0": {} },
        },
      },
      "https://api.npmjs.org/downloads/point/last-week/zod": { body: { downloads: 10, package: "zod" } },
      "https://api.npmjs.org/downloads/point/last-month/zod": { body: { downloads: 40, package: "zod" } },
      [affectUrl("zod", advisoryVersion)]: { status, body: status === 200 ? [] : {} },
    };
  }

  let fetchMock = mockFetch(zodBundle("4.0.0"));
  const latest = await researchPackage("zod");
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("zod", "4.0.0")
  );
  expect(latest.security.checkedVersion).toBe("4.0.0");

  fetchMock = mockFetch(zodBundle("1.2.3"));
  const ranged = await researchPackage("zod", "^1.2.3");
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("zod", "1.2.3")
  );
  expect(ranged.security.checkedVersion).toBe("1.2.3");

  mockFetch(zodBundle("4.0.0", 403));
  const failed = await researchPackage("zod");
  expect(failed.security.advisoryCount).toBeNull();
  expect(failed.security.criticalCount).toBeNull();
  expect(failed.security.highCount).toBeNull();
  expect(failed.security.error).toBe(
    "GitHub advisory lookup failed for zod: HTTP 403. GitHub's rate limit may be used up. Set GITHUB_TOKEN to raise it."
  );
});

test("versionsBehind ignores prereleases", async () => {
  // source: versionsBehind counted prereleases, so a release candidate looked like another version behind.
  const versions = ["1.0.0", "1.1.0", "2.0.0-rc.1", "2.0.0"];
  const fixtures: Record<string, Fixture> = {
    "https://registry.npmjs.org/steps": {
      body: {
        name: "steps",
        version: "2.0.0",
        "dist-tags": { latest: "2.0.0" },
        versions: Object.fromEntries(versions.map((version) => [version, {}])),
      },
    },
    "https://api.npmjs.org/downloads/point/last-week/steps": { body: { downloads: 1, package: "steps" } },
    "https://api.npmjs.org/downloads/point/last-month/steps": { body: { downloads: 4, package: "steps" } },
    [affectUrl("steps", "1.0.0")]: { body: [] },
    [affectUrl("steps", "1.1.0")]: { body: [] },
    [affectUrl("steps", "2.0.0")]: { body: [] },
  };
  mockFetch(fixtures);

  expect((await researchPackage("steps", "1.0.0")).versionsBehind).toBe(2);
  expect((await researchPackage("steps", "2.0.0")).versionsBehind).toBe(0);
  expect((await researchPackage("steps", "^1.0.5")).versionsBehind).toBe(1);
  const omitted = await researchPackage("steps");
  expect(omitted.versionsBehind).toBeUndefined();
  expect("versionsBehind" in omitted).toBe(false);
});

test("compare_packages marks a 404 and a registry 500 without dropping the other package", async () => {
  // source: a registry failure was reported as not found, and one failure failed the whole comparison.
  mockFetch({
    "https://registry.npmjs.org/gone": { status: 404, body: {} },
    ...packageBundle("kept", { name: "kept", version: "1.2.0", "dist-tags": { latest: "1.2.0" } }, 15),
  });
  let notFoundRejection: unknown = null;
  let missing: Awaited<ReturnType<typeof comparePackages>> | undefined;
  try {
    missing = await comparePackages(["gone", "kept"]);
  } catch (error) {
    notFoundRejection = error;
  }
  expect(notFoundRejection).toBeNull();
  expect(missing?.packages.find((pkg) => pkg.name === "gone")).toEqual({
    name: "gone",
    status: "not-found",
  });
  expect(missing?.packages.find((pkg) => pkg.name === "kept")?.status).toBe("found");
  expect(missing?.packages.find((pkg) => pkg.name === "kept")?.version).toBe("1.2.0");

  mockFetch({
    "https://registry.npmjs.org/bad": { status: 500, body: {} },
    ...packageBundle("kept", { name: "kept", version: "1.0.0", "dist-tags": { latest: "1.0.0" } }, 8),
  });
  let lookupRejection: unknown = null;
  let failed: Awaited<ReturnType<typeof comparePackages>> | undefined;
  try {
    failed = await comparePackages(["bad", "kept"]);
  } catch (error) {
    lookupRejection = error;
  }
  expect(lookupRejection).toBeNull();
  expect(failed?.packages.find((pkg) => pkg.name === "bad")).toEqual({
    name: "bad",
    status: "lookup-failed",
    error: "npm registry lookup failed for bad: HTTP 500",
  });
  expect(failed?.packages.find((pkg) => pkg.name === "kept")?.status).toBe("found");
  expect(failed?.packages.find((pkg) => pkg.name === "kept")?.version).toBe("1.0.0");
});

test("compare_packages recommendation names the leader and the package missing stars", async () => {
  // source: the comparison blended downloads and stars into one score and printed unknown for a missing count.
  mockFetch({
    ...packageBundle("alpha", {
      name: "alpha",
      version: "1.0.0",
      "dist-tags": { latest: "1.0.0" },
      repository: "https://github.com/acme/alpha",
    }, 1000),
    "https://api.github.com/repos/acme/alpha": {
      body: {
        name: "alpha",
        full_name: "acme/alpha",
        description: null,
        stargazers_count: 40,
        forks_count: 1,
        open_issues_count: 0,
        license: null,
        pushed_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        archived: false,
        disabled: false,
      },
    },
    ...packageBundle("beta", {
      name: "beta",
      version: "2.0.0",
      "dist-tags": { latest: "2.0.0" },
    }, 2500),
  });

  const result = await comparePackages(["alpha", "beta"]);
  expect(result.recommendation).toBe(
    '"beta" has the most weekly downloads (2,500). GitHub stars were not available for: beta.'
  );
});

test("analyze_package_json does not send workspace or file dependencies to the registry", async () => {
  // source: workspace and file dependencies were sent to public services under their package names.
  const fetchMock = mockFetch({
    ...dependencyFixtures("kept", "1.0.0", "1.0.0"),
  });
  await analyzePackageJson({
    dependencies: { kept: "1.0.0", "ws-dep": "workspace:*", "file-dep": "file:../x" },
  });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("ws-dep"))).toBe(false);
  expect(urls.some((url) => url.includes("file-dep"))).toBe(false);
  expect(urls.some((url) => url.includes("kept"))).toBe(true);
});

test("a latest dependency is checked at the latest published version", async () => {
  // source: a latest tag skipped the advisory lookup, so the version a fresh install would get was never checked.
  const fetchMock = mockFetch({
    ...registryDownloads("tagged", "2.0.0"),
    [affectUrl("tagged", "2.0.0")]: { body: [] },
  });
  const result = await analyzePackageJson({ dependencies: { tagged: "latest" } });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toContain(affectUrl("tagged", "2.0.0"));
  expect(result.dependencies[0]).toMatchObject({
    current: "2.0.0",
    spec: "latest",
    resolvedFrom: "latest",
    status: "up-to-date",
    securityIssues: 0,
  });
});

test("a failed advisory lookup is not counted as zero issues", async () => {
  // source: a failed advisory lookup was stored as securityIssues 0 next to the error.
  mockFetch({
    ...registryDownloads("lodash", "4.17.21"),
    [affectUrl("lodash", "4.17.21")]: { status: 500, body: {} },
  });
  const result = await analyzePackageJson({ dependencies: { lodash: "4.17.21" } });
  expect(result.dependencies[0]?.securityIssues).toBeNull();
  expect(result.dependencies[0]?.securityError).toBe(
    "GitHub advisory lookup failed for lodash: HTTP 500"
  );
});

test("totalDependencies counts the whole list and a cut list is not called fully up to date", async () => {
  // source: totalDependencies was the number analyzed, and a cut list of up-to-date packages said all packages were up to date.
  const dependencies: Record<string, string> = {};
  const fixtures: Record<string, Fixture> = {};
  for (let index = 0; index < 25; index += 1) {
    const name = `dep${index}`;
    dependencies[name] = "1.2.0";
    Object.assign(fixtures, dependencyFixtures(name, "1.2.0", "1.2.0"));
  }
  mockFetch(fixtures);

  const result = await analyzePackageJson({ dependencies });
  expect(result.totalDependencies).toBe(25);
  expect(result.analyzedDependencies).toBe(20);
  expect(result.summary).toContain("The 20 analyzed are up to date.");
  expect(result.summary).not.toContain("All packages are up to date.");
});

test("an empty package.json says there are no dependencies to analyze", async () => {
  // source: an empty package.json was summarized as if packages had been checked.
  mockFetch({});
  const result = await analyzePackageJson({});
  expect(result.summary).toBe("No dependencies to analyze.");
});

test("a deprecated dependency is named in the result, the priorities, and the summary", async () => {
  // source: npm's deprecation notice was dropped, so a deprecated dependency looked current.
  mockFetch({
    "https://registry.npmjs.org/old-lib": {
      body: {
        name: "old-lib",
        version: "1.0.0",
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { deprecated: "no longer maintained" } },
      },
    },
    "https://api.npmjs.org/downloads/point/last-week/old-lib": { body: { downloads: 3, package: "old-lib" } },
    [affectUrl("old-lib", "1.0.0")]: { body: [] },
  });
  const result = await analyzePackageJson({ dependencies: { "old-lib": "1.0.0" } });
  expect(result.dependencies[0]?.deprecated).toBe("no longer maintained");
  expect(result.topPriorities).toContain("old-lib is deprecated on npm");
  expect(result.summary).toContain("1 deprecated.");
});

test("get_trending lists only the category argument", () => {
  // source: get_trending advertised a framework argument that the curated lists cannot answer.
  const trending = tools.find((tool) => tool.name === "get_trending");
  const schema = trending?.inputSchema as { properties?: Record<string, unknown> };
  expect(Object.keys(schema.properties ?? {})).toEqual(["category"]);
});

test("weekly downloads against a monthly average choose rising, stable, declining, or unknown", async () => {
  // source: the trend label divided the month by 4, a missing month was called stable, and weekly 60 against monthly 400 was not called declining.
  function point(name: string, weekly: number, monthly: number | null): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: {
        body: { downloads: weekly, package: name },
      },
      [`https://api.npmjs.org/downloads/point/last-month/${encoded}`]: monthly === null
        ? { status: 404, body: {} }
        : { body: { downloads: monthly, package: name } },
    };
  }
  const names = ["zod", "yup", "valibot", "ajv", "joi", "superstruct"];
  mockFetch({
    ...point("zod", 108, 400),
    ...point("yup", 88, 400),
    ...point("valibot", 50, null),
    ...point("ajv", 60, 400),
    ...point("joi", 10, 40),
    ...point("superstruct", 10, 40),
  });
  const result = await getTrending("validation");
  const label = (name: string) => result.packages.find((pkg) => pkg.name === name)?.trending;
  expect(label("zod")).toBe("rising");
  expect(label("yup")).toBe("stable");
  expect(label("valibot")).toBe("unknown");
  expect(label("ajv")).toBe("declining");
  expect(names.every((name) => result.packages.some((pkg) => pkg.name === name))).toBe(true);
});

test("get_trending reports packages it could not load", async () => {
  // source: a 404 or a registry 500 was dropped from the trending list with no reason.
  function ok(name: string): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: { body: { downloads: 10, package: name } },
      [`https://api.npmjs.org/downloads/point/last-month/${encoded}`]: { body: { downloads: 40, package: name } },
    };
  }
  mockFetch({
    "https://registry.npmjs.org/vitest": { status: 404, body: {} },
    "https://registry.npmjs.org/jest": { status: 500, body: {} },
    ...ok("@testing-library/react"),
    ...ok("playwright"),
    ...ok("cypress"),
    "https://registry.npmjs.org/mocha": {
      body: { name: "mocha", version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
    },
    "https://api.npmjs.org/downloads/point/last-week/mocha": { status: 404, body: {} },
    "https://api.npmjs.org/downloads/point/last-month/mocha": { body: { downloads: 40, package: "mocha" } },
    ...ok("ava"),
  });
  const result = await getTrending("testing");
  expect(result.notLoaded).toEqual([
    { name: "vitest", reason: "not found on npm" },
    { name: "jest", reason: "npm registry lookup failed for jest: HTTP 500" },
    { name: "mocha", reason: "weekly downloads unavailable" },
  ]);
  const loaded = result.packages.map((pkg) => pkg.name);
  expect(loaded).not.toContain("vitest");
  expect(loaded).not.toContain("jest");
  expect(loaded).not.toContain("mocha");
  expect(loaded).toContain("ava");
});

test("curated trending names match packages that exist on npm", async () => {
  // source: date-time asked for tempo and bundler asked for turbopack, which are not those packages on npm.
  function ok(name: string): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: { body: { downloads: 10, package: name } },
      [`https://api.npmjs.org/downloads/point/last-month/${encoded}`]: { body: { downloads: 40, package: name } },
    };
  }
  const dateTime = ["date-fns", "dayjs", "luxon", "moment", "@formkit/tempo", "@internationalized/date"];
  const dateFixtures: Record<string, Fixture> = {};
  for (const name of dateTime) Object.assign(dateFixtures, ok(name));
  let fetchMock = mockFetch(dateFixtures);
  await getTrending("date-time");
  let urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("%40formkit%2Ftempo"))).toBe(true);
  expect(urls.some((url) => /\/tempo(?:[/?]|$)/.test(url))).toBe(false);

  const bundler = ["vite", "esbuild", "rollup", "webpack", "parcel", "tsup"];
  const bundlerFixtures: Record<string, Fixture> = {};
  for (const name of bundler) Object.assign(bundlerFixtures, ok(name));
  fetchMock = mockFetch(bundlerFixtures);
  await getTrending("bundler");
  urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("turbopack"))).toBe(false);
});

test("find_alternatives requests the packages that exist on npm today", async () => {
  // source: curated alternatives named foundation, hapi, and recoil, which are the wrong packages on npm.
  function ok(name: string): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: { body: { downloads: 10, package: name } },
    };
  }
  let fetchMock = mockFetch({
    ...ok("tailwindcss"),
    ...ok("bulma"),
    ...ok("foundation-sites"),
  });
  await findAlternatives("bootstrap");
  let urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("foundation-sites"))).toBe(true);
  expect(urls.some((url) => /\/foundation(?:[/?]|$)/.test(url))).toBe(false);

  fetchMock = mockFetch({
    ...ok("fastify"),
    ...ok("koa"),
    ...ok("hono"),
    ...ok("@hapi/hapi"),
  });
  await findAlternatives("express");
  urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("%40hapi%2Fhapi"))).toBe(true);
  expect(urls.some((url) => /\/hapi(?:[/?]|$)/.test(url))).toBe(false);

  fetchMock = mockFetch({
    ...ok("zustand"),
    ...ok("jotai"),
    ...ok("mobx"),
    ...ok("valtio"),
  });
  await findAlternatives("redux");
  urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("recoil"))).toBe(false);
});

test("find_alternatives lists only the package argument", () => {
  // source: find_alternatives advertised a category argument that the function never read.
  const alternatives = tools.find((tool) => tool.name === "find_alternatives");
  const schema = alternatives?.inputSchema as { properties?: Record<string, unknown> };
  expect(Object.keys(schema.properties ?? {})).toEqual(["package"]);
});

test("curated notes do not use promotional adjectives", () => {
  // source: pros and cons used words such as Tiny, Great, and Lightning that the notes do not support.
  const banned = ["Tiny", "Great", "Smallest", "Fast", "Lightweight", "High performance", "Lightning"];
  const notes = Object.values(alternativeNotes());
  expect(notes.length).toBeGreaterThan(0);
  for (const entry of notes) {
    for (const text of [...entry.pros, ...entry.cons]) {
      for (const word of banned) {
        expect(text.includes(word)).toBe(false);
      }
    }
  }
});

test("a registry failure stays in notLoaded and the other alternatives remain", async () => {
  // source: one failed alternative lookup dropped that package and could fail the whole list.
  mockFetch({
    "https://registry.npmjs.org/date-fns": {
      body: { name: "date-fns", version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
    },
    "https://api.npmjs.org/downloads/point/last-week/date-fns": { body: { downloads: 300, package: "date-fns" } },
    "https://registry.npmjs.org/dayjs": {
      body: { name: "dayjs", version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
    },
    "https://api.npmjs.org/downloads/point/last-week/dayjs": { body: { downloads: 200, package: "dayjs" } },
    "https://registry.npmjs.org/luxon": { status: 500, body: {} },
  });
  const result = await findAlternatives("moment");
  expect(result.notLoaded).toEqual([
    { name: "luxon", reason: "npm registry lookup failed for luxon: HTTP 500" },
  ]);
  expect(result.alternatives.map((item) => item.name)).toEqual(["date-fns", "dayjs"]);
});

test("find_alternatives recommendation sentences follow downloads and migration effort", async () => {
  // source: the recommendation blended popularity and migration effort into one sentence.
  function ok(name: string, downloads?: number): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: downloads === undefined
        ? { status: 404, body: {} }
        : { body: { downloads, package: name } },
    };
  }

  mockFetch({
    ...ok("valibot", 100),
    ...ok("yup", 40),
    ...ok("joi", 30),
    ...ok("ajv", 20),
  });
  expect((await findAlternatives("zod")).recommendation).toBe(
    '"valibot" has the most weekly downloads of these (100).'
  );

  mockFetch({
    ...ok("date-fns", 2500),
    ...ok("dayjs", 800),
    ...ok("luxon", 100),
  });
  expect((await findAlternatives("moment")).recommendation).toBe(
    '"date-fns" has the most weekly downloads of these (2,500). "dayjs" is rated low migration effort from "moment".'
  );

  mockFetch({
    ...ok("date-fns"),
    ...ok("dayjs"),
    ...ok("luxon"),
  });
  expect((await findAlternatives("moment")).recommendation).toBe(
    "Weekly downloads were not available, so the alternatives are in curated order."
  );
});

test("parseGitHubRepo reads github urls, shorthand, and owner/repo", () => {
  // source: a repository field of github:owner/repo or a URL ending in #branch produced no stars.
  const table: Array<[string, { owner: string; repo: string } | null]> = [
    ["https://github.com/acme/pkg", { owner: "acme", repo: "pkg" }],
    ["https://github.com/acme/pkg.git", { owner: "acme", repo: "pkg" }],
    ["git+https://github.com/acme/pkg.git", { owner: "acme", repo: "pkg" }],
    ["git://github.com/acme/pkg", { owner: "acme", repo: "pkg" }],
    ["git://github.com/acme/pkg.git", { owner: "acme", repo: "pkg" }],
    ["git+ssh://git@github.com/acme/pkg.git", { owner: "acme", repo: "pkg" }],
    ["git@github.com:acme/pkg", { owner: "acme", repo: "pkg" }],
    ["git@github.com:acme/pkg.git", { owner: "acme", repo: "pkg" }],
    ["https://github.com/acme/pkg/tree/main", { owner: "acme", repo: "pkg" }],
    ["git+https://github.com/emotion-js/emotion.git#main", { owner: "emotion-js", repo: "emotion" }],
    ["https://github.com/acme/pkg.git?foo=1", { owner: "acme", repo: "pkg" }],
    ["github:emotion-js/emotion", { owner: "emotion-js", repo: "emotion" }],
    ["emotion-js/emotion", { owner: "emotion-js", repo: "emotion" }],
    ["https://gitlab.com/acme/pkg", null],
    ["https://bitbucket.org/acme/pkg", null],
    ["gitlab:acme/pkg", null],
    ["not a repository", null],
  ];
  for (const [input, expected] of table) {
    expect(parseGitHubRepo(input)).toEqual(expected);
  }
});

test("hasTypeScriptSupport reads a types key nested in exports", () => {
  // source: a package whose only type information was exports types was reported as having no types.
  expect(hasTypeScriptSupport({
    name: "pkg",
    version: "1.0.0",
    versions: {
      "1.0.0": {
        exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
      },
    },
  })).toBe(true);
  expect(hasTypeScriptSupport({
    name: "pkg",
    version: "1.0.0",
    versions: {
      "1.0.0": {
        exports: { ".": { import: "./index.js" } },
      },
    },
  })).toBe(false);
});

test("tool descriptions do not promise bundle size or a framework argument", () => {
  // source: tool descriptions promised bundle sizes and deprecation warnings, and listed framework or category arguments that are not read.
  for (const tool of tools) {
    const description = (tool.description ?? "").toLowerCase();
    expect(description).not.toContain("bundle");
    expect(description).not.toContain("deprecated packages");
  }
  const trending = tools.find((tool) => tool.name === "get_trending");
  const alternatives = tools.find((tool) => tool.name === "find_alternatives");
  const trendingSchema = trending?.inputSchema as { properties?: Record<string, unknown> };
  const alternativesSchema = alternatives?.inputSchema as { properties?: Record<string, unknown> };
  expect(Object.keys(trendingSchema.properties ?? {})).toEqual(["category"]);
  expect(Object.keys(alternativesSchema.properties ?? {})).toEqual(["package"]);
  expect(Object.keys(trendingSchema.properties ?? {})).not.toContain("framework");
  expect(Object.keys(alternativesSchema.properties ?? {})).not.toContain("category");
  // source: check_security and analyze_package_json still said a range is the newest version it allows.
  expect(
    ["check_security", "analyze_package_json"].every((name) =>
      (tools.find((tool) => tool.name === name)?.description ?? "").includes(
        "the version a fresh install would get"
      )
    )
  ).toBe(true);
});

test("registry, download, github, advisory, and exa research requests pass an abort signal", async () => {
  // source: the advisory client and the two Exa research calls had no time limit.
  const fetchMock = mockFetch({
    "https://registry.npmjs.org/left-pad": {
      body: { name: "left-pad", version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
    },
    "https://api.npmjs.org/downloads/point/last-week/left-pad": { body: { downloads: 1, package: "left-pad" } },
    "https://api.github.com/repos/acme/left-pad": { body: { name: "left-pad", stargazers_count: 1 } },
    [affectUrl("left-pad", "1.0.0")]: { body: [] },
    "https://api.exa.ai/research/v1": { body: { researchId: "r1" } },
    "https://api.exa.ai/research/v1/r1": { body: { researchId: "r1", status: "completed" } },
  });

  await fetchPackageData("left-pad");
  await fetchDownloads("left-pad", "last-week");
  await fetchRepo("acme", "left-pad");
  await checkSecurityAdvisories("left-pad", "1.0.0");
  const client = new ExaDeepClient("test-key");
  await client.createResearchTask({ model: "exa-research", instructions: "look" });
  await client.getResearchTask("r1");

  const expected = [
    "https://registry.npmjs.org/left-pad",
    "https://api.npmjs.org/downloads/point/last-week/left-pad",
    "https://api.github.com/repos/acme/left-pad",
    affectUrl("left-pad", "1.0.0"),
    "https://api.exa.ai/research/v1",
    "https://api.exa.ai/research/v1/r1",
  ];
  for (const url of expected) {
    const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  }
});

test("advisory 403 and 429 mention the rate limit and 500 does not", async () => {
  // source: a 403 or 429 looked like any other HTTP failure, with no mention of the rate limit.
  const rateLimit = "GitHub's rate limit may be used up. Set GITHUB_TOKEN to raise it.";
  async function messageFor(status: number): Promise<string> {
    mockFetch({
      [affectUrl("lodash", "4.17.21")]: { status, body: {} },
    });
    const error = await checkSecurityAdvisories("lodash", "4.17.21").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    return error instanceof Error ? error.message : "";
  }

  const forbidden = await messageFor(403);
  expect(forbidden.endsWith(rateLimit)).toBe(true);
  expect(forbidden).toBe(`GitHub advisory lookup failed for lodash: HTTP 403. ${rateLimit}`);

  const limited = await messageFor(429);
  expect(limited.endsWith(rateLimit)).toBe(true);
  expect(limited).toBe(`GitHub advisory lookup failed for lodash: HTTP 429. ${rateLimit}`);

  const failure = await messageFor(500);
  expect(failure.endsWith(rateLimit)).toBe(false);
  expect(failure).toBe("GitHub advisory lookup failed for lodash: HTTP 500");
});

test("a list cut at ten advisory pages is a failed lookup", async () => {
  // source: a list cut at ten pages was returned as if it were complete
  const first = affectUrl("lodash", "4.17.21");
  const fixtures: Record<string, Fixture> = {};
  for (let page = 1; page <= 10; page += 1) {
    const url = page === 1 ? first : `${first}&page=${page}`;
    fixtures[url] = {
      body: [],
      headers: { Link: `<${first}&page=${page + 1}>; rel="next"` },
    };
  }
  const fetchMock = mockFetch(fixtures);
  const error = await checkSecurityAdvisories("lodash", "4.17.21").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AdvisoryLookupError);
  expect(error).toMatchObject({
    message: "GitHub advisory lookup failed for lodash: more than 1,000 advisories, so the list is incomplete",
  });
  expect(fetchMock).toHaveBeenCalledTimes(10);
});

test("check_security on a missing package returns only identity fields", async () => {
  // source: a package that is not on npm was reported with totalAdvisories 0, which reads as clean.
  mockFetch({
    "https://registry.npmjs.org/missing-pkg": { status: 404, body: {} },
  });
  const omitted = await checkSecurity("missing-pkg");
  expect(Object.keys(omitted).sort()).toEqual(["found", "package", "recommendation"]);

  mockFetch({
    "https://registry.npmjs.org/missing-pkg": { status: 404, body: {} },
  });
  const given = await checkSecurity("missing-pkg", "1.2.3");
  expect(Object.keys(given).sort()).toEqual(["found", "package", "recommendation", "version"]);
  expect(given.version).toBe("1.2.3");
});

test("analyze_package_json does not request advisories for a package npm does not have", async () => {
  // source: a dependency was sent to the advisory API after the registry said it does not exist.
  const fetchMock = mockFetch({
    "https://registry.npmjs.org/ghost": { status: 404, body: {} },
    "https://api.npmjs.org/downloads/point/last-week/ghost": { status: 404, body: {} },
  });

  const result = await analyzePackageJson({ dependencies: { ghost: "1.0.0" } });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.filter((url) => url.includes("api.github.com/advisories") && url.includes("ghost"))).toEqual([]);
  expect(urls.some((url) => url.includes("registry.npmjs.org/ghost"))).toBe(true);
  expect(result.dependencies[0]).toMatchObject({
    name: "ghost",
    status: "unknown",
    securityIssues: null,
    recommendation: "Package not found on npm",
  });
  expect(result.dependencies[0]?.securityError).toBeUndefined();
  expect("securityError" in (result.dependencies[0] ?? {})).toBe(false);
});

test("critical or high advisories name the package and the version in use", async () => {
  // source: critical or high advisories were reported with a warning sign and an exclamation.
  mockFetch({
    ...registryDownloads("widget", "1.1.0"),
    [affectUrl("widget", "1.0.0")]: { body: [ghsa("widget", "GHSA-c1", "critical")] },
  });
  const behind = await analyzePackageJson({ dependencies: { widget: "1.0.0" } });
  expect(behind.dependencies[0]?.recommendation).toBe(
    "1 critical or high severity advisory affects widget 1.0.0. Latest version: 1.1.0."
  );

  mockFetch({
    ...registryDownloads("widget", "1.2.3"),
    [affectUrl("widget", "1.2.3")]: {
      body: [ghsa("widget", "GHSA-h1", "high"), ghsa("widget", "GHSA-h2", "high")],
    },
  });
  const current = await analyzePackageJson({ dependencies: { widget: "1.2.3" } });
  expect(current.dependencies[0]?.recommendation).toBe(
    "2 critical or high severity advisories affect widget 1.2.3."
  );
});

test("summaries count advisories and say when every package is up to date", async () => {
  // source: the summary used a warning sign for advisories and an exclamation when every package was up to date.
  mockFetch({
    ...registryDownloads("widget", "1.1.0"),
    [affectUrl("widget", "1.0.0")]: { body: [ghsa("widget", "GHSA-c1", "critical")] },
  });
  const one = await analyzePackageJson({ dependencies: { widget: "1.0.0" } });
  expect(one.summary).toBe(
    "Analyzed 1 dependencies. Advisories affecting the versions in use: 1. 1 packages have updates available."
  );

  mockFetch(dependencyFixtures("clean", "1.0.0", "1.0.0"));
  const clean = await analyzePackageJson({ dependencies: { clean: "1.0.0" } });
  expect(clean.summary).toBe("Analyzed 1 dependencies. All packages are up to date.");
});

test("top priorities name the advisory and the major update", async () => {
  // source: top priorities used a lock emoji for advisories and a box emoji for major updates.
  mockFetch({
    ...registryDownloads("alpha", "1.0.0"),
    [affectUrl("alpha", "1.0.0")]: {
      body: [ghsa("alpha", "GHSA-a1", "high"), ghsa("alpha", "GHSA-a2", "high")],
    },
    ...registryDownloads("beta", "1.2.0"),
    [affectUrl("beta", "1.2.0")]: { body: [ghsa("beta", "GHSA-b1", "critical")] },
    ...dependencyFixtures("gamma", "2.0.0", "1.0.0"),
  });

  const result = await analyzePackageJson({
    dependencies: { alpha: "1.0.0", beta: "1.2.0", gamma: "1.0.0" },
  });
  expect(result.topPriorities[0]).toBe("alpha: 2 advisories affect 1.0.0");
  expect(result.topPriorities[1]).toBe("beta: 1 advisory affects 1.2.0");
  expect(result.topPriorities[2]).toBe("gamma: major update 1.0.0 to 2.0.0");
  expect(result.topPriorities).toHaveLength(3);
});

test("an unusable npm latest version is described as npm's version", async () => {
  // source: the recommendation blamed the version spec when npm's latest version was not comparable.
  mockFetch({
    ...registryDownloads("odd", "not-a-version"),
    [affectUrl("odd", "1.0.0")]: { body: [] },
  });
  const result = await analyzePackageJson({ dependencies: { odd: "1.0.0" } });
  expect(result.dependencies[0]?.recommendation).toBe(
    'The latest version on npm ("not-a-version") is not a version that can be compared.'
  );
  expect(result.dependencies[0]?.status).toBe("unknown");
});

test("analyze_package_json and check_security answers contain no exclamation or emoji", async () => {
  // source: answer strings from analyze_package_json and check_security carried emoji and exclamation marks.
  const results: unknown[] = [];

  async function take(fixtures: Record<string, Fixture>, run: () => Promise<unknown>): Promise<void> {
    mockFetch(fixtures);
    results.push(await run());
  }

  await take(
    { "https://registry.npmjs.org/missing-pkg": { status: 404, body: {} } },
    () => checkSecurity("missing-pkg")
  );
  await take(
    { "https://registry.npmjs.org/missing-pkg": { status: 404, body: {} } },
    () => checkSecurity("missing-pkg", "1.2.3")
  );
  await take(
    {
      ...registryLatest("lodash", "4.17.21"),
      [affectUrl("lodash", "4.17.21")]: { body: [] },
    },
    () => checkSecurity("lodash")
  );
  await take(
    {
      ...registryLatest("lodash", "4.17.21"),
      [affectUrl("lodash", "4.17.20")]: { body: [] },
    },
    () => checkSecurity("lodash", "4.17.20")
  );
  await take(
    {
      "https://registry.npmjs.org/lodash": {
        body: {
          name: "lodash",
          version: "4.17.21",
          "dist-tags": { latest: "4.17.21" },
          versions: { "4.17.0": {}, "4.17.21": {} },
        },
      },
      [affectUrl("lodash", "4.17.21")]: { body: [] },
    },
    () => checkSecurity("lodash", "^4.17.0")
  );
  await take(
    {
      ...registryLatest("lodash", "4.17.21"),
      [affectUrl("lodash", "4.17.21")]: { body: [] },
    },
    () => checkSecurity("lodash", "latest")
  );

  const advisoryBodies: unknown[][] = [
    [],
    [ghsa("widget", "GHSA-c1", "critical")],
    [ghsa("widget", "GHSA-c1", "critical"), ghsa("widget", "GHSA-c2", "critical")],
    [ghsa("widget", "GHSA-h1", "high")],
    [ghsa("widget", "GHSA-h1", "high"), ghsa("widget", "GHSA-h2", "high")],
    [ghsa("widget", "GHSA-m1", "moderate")],
    [ghsa("widget", "GHSA-m1", "moderate"), ghsa("widget", "GHSA-m2", "moderate")],
  ];
  for (const body of advisoryBodies) {
    await take(
      {
        ...registryLatest("widget", "1.2.3"),
        [affectUrl("widget", "1.2.3")]: { body },
      },
      () => checkSecurity("widget")
    );
  }
  await take(
    {
      ...registryLatest("widget", "2.0.0"),
      [affectUrl("widget", "1.0.0")]: { body: [ghsa("widget", "GHSA-h1", "high")] },
    },
    () => checkSecurity("widget", "1.0.0")
  );

  await take(
    {
      ...dependencyFixtures("a", "1.5.0", "1.2.0"),
      "https://registry.npmjs.org/a": {
        body: {
          name: "a",
          version: "1.5.0",
          "dist-tags": { latest: "1.5.0" },
          versions: { "1.0.0": {} },
        },
      },
      ...registryDownloads("b", "9.0.0"),
      [affectUrl("b", "9.0.0")]: { body: [] },
      ...dependencyFixtures("d", "1.0.0", "1.0.0"),
    },
    () => analyzePackageJson({
      dependencies: { a: "^1.2.0", b: "latest", c: "workspace:*", d: "1.0.0" },
    })
  );
  const specFixtures: Record<string, Fixture> = {};
  for (const name of ["star", "blank"]) Object.assign(specFixtures, dependencyFixtures(name, "1.0.0", "1.0.0"));
  await take(specFixtures, () => analyzePackageJson({
    dependencies: {
      star: "*",
      blank: "",
      filedep: "file:../local",
      npmalias: "npm:left-pad@1.0.0",
      gitdep: "git+https://github.com/acme/pkg.git",
      httpdep: "https://example.com/pkg.tgz",
      linkdep: "link:../pkg",
    },
  }));
  await take(
    {
      ...dependencyFixtures("newer", "1.5.0", "2.0.0"),
      ...dependencyFixtures("pre", "2.0.0-beta.1", "1.0.0"),
      ...dependencyFixtures("preminor", "1.1.0-beta.1", "1.0.0"),
    },
    () => analyzePackageJson({ dependencies: { newer: "2.0.0", pre: "1.0.0", preminor: "1.0.0" } })
  );
  await take(
    {
      ...dependencyFixtures("hyphen", "2.1.0", "1.2.3"),
      ...dependencyFixtures("space", "1.9.0", "1.2.3"),
      [affectUrl("space", "1.9.0")]: { body: [] },
      ...dependencyFixtures("xrange", "1.5.0", "1.0.0"),
      [affectUrl("xrange", "1.5.0")]: { body: [] },
    },
    () => analyzePackageJson({
      dependencies: { hyphen: "1.2.3 - 2.0.0", space: ">=1.2.3 <2.0.0", xrange: "1.x" },
    })
  );
  await take(
    {
      "https://registry.npmjs.org/bad": new Error("registry down"),
      "https://api.npmjs.org/downloads/point/last-week/bad": { body: { downloads: 1, package: "bad" } },
      ...dependencyFixtures("good", "1.0.0", "1.0.0"),
    },
    () => analyzePackageJson({ dependencies: { good: "1.0.0", bad: "2.0.0" } })
  );
  await take(
    {
      ...dependencyFixtures("patchy", "1.0.1", "1.0.0"),
      ...dependencyFixtures("minory", "1.1.0", "1.0.0"),
      ...dependencyFixtures("majory", "2.0.0", "1.0.0"),
    },
    () => analyzePackageJson({ dependencies: { patchy: "1.0.0", minory: "1.0.0", majory: "1.0.0" } })
  );
  await take(
    {
      ...registryDownloads("lodash", "4.17.21"),
      [affectUrl("lodash", "4.17.21")]: { status: 500, body: {} },
    },
    () => analyzePackageJson({ dependencies: { lodash: "4.17.21" } })
  );
  await take({}, () => analyzePackageJson({}));
  await take(
    {
      "https://registry.npmjs.org/old-lib": {
        body: {
          name: "old-lib",
          version: "1.0.0",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { deprecated: "no longer maintained" } },
        },
      },
      "https://api.npmjs.org/downloads/point/last-week/old-lib": { body: { downloads: 3, package: "old-lib" } },
      [affectUrl("old-lib", "1.0.0")]: { body: [] },
    },
    () => analyzePackageJson({ dependencies: { "old-lib": "1.0.0" } })
  );
  await take(
    {
      "https://registry.npmjs.org/ghost": { status: 404, body: {} },
      "https://api.npmjs.org/downloads/point/last-week/ghost": { status: 404, body: {} },
    },
    () => analyzePackageJson({ dependencies: { ghost: "1.0.0" } })
  );
  await take(
    {
      ...registryDownloads("odd", "not-a-version"),
      [affectUrl("odd", "1.0.0")]: { body: [] },
    },
    () => analyzePackageJson({ dependencies: { odd: "1.0.0" } })
  );
  await take(
    {
      ...registryDownloads("widget", "1.1.0"),
      [affectUrl("widget", "1.0.0")]: { body: [ghsa("widget", "GHSA-c1", "critical")] },
    },
    () => analyzePackageJson({ dependencies: { widget: "1.0.0" } })
  );
  await take(
    {
      ...registryDownloads("widget", "1.2.3"),
      [affectUrl("widget", "1.2.3")]: {
        body: [ghsa("widget", "GHSA-h1", "high"), ghsa("widget", "GHSA-h2", "high")],
      },
    },
    () => analyzePackageJson({ dependencies: { widget: "1.2.3" } })
  );
  await take(
    {
      ...registryDownloads("alpha", "1.0.0"),
      [affectUrl("alpha", "1.0.0")]: {
        body: [ghsa("alpha", "GHSA-a1", "high"), ghsa("alpha", "GHSA-a2", "high")],
      },
      ...registryDownloads("beta", "1.2.0"),
      [affectUrl("beta", "1.2.0")]: { body: [ghsa("beta", "GHSA-b1", "critical")] },
      ...dependencyFixtures("gamma", "2.0.0", "1.0.0"),
    },
    () => analyzePackageJson({ dependencies: { alpha: "1.0.0", beta: "1.2.0", gamma: "1.0.0" } })
  );
  await take(dependencyFixtures("clean", "1.0.0", "1.0.0"), () =>
    analyzePackageJson({ dependencies: { clean: "1.0.0" } })
  );

  const manyDeps: Record<string, string> = {};
  const manyFixtures: Record<string, Fixture> = {};
  for (let index = 0; index < 25; index += 1) {
    const name = `dep${index}`;
    manyDeps[name] = "1.2.0";
    Object.assign(manyFixtures, dependencyFixtures(name, "1.2.0", "1.2.0"));
  }
  await take(manyFixtures, () => analyzePackageJson({ dependencies: manyDeps }));

  const devDependencies: Record<string, string> = {};
  const devFixtures: Record<string, Fixture> = {};
  for (let index = 0; index < 12; index += 1) {
    const name = `dev${index}`;
    devDependencies[name] = "1.0.0";
    Object.assign(devFixtures, dependencyFixtures(name, "1.0.0", "1.0.0"));
  }
  await take(devFixtures, () => analyzePackageJson({ dependencies: {}, devDependencies }));

  for (const result of results) {
    const json = JSON.stringify(result);
    expect(json).not.toContain("!");
    expect(/\p{Extended_Pictographic}/u.test(json)).toBe(false);
  }
});

const versionTablePackage = {
  name: "lodash",
  version: "4.17.21",
  versions: {
    "1.0.0": {},
    "1.9.9": {},
    "2.0.0": {},
    "4.17.0": {},
    "4.17.15": {},
    "4.17.21": {},
    "5.0.0-beta.1": {},
  },
  "dist-tags": { latest: "4.17.21", next: "5.0.0-beta.1" },
};

test("resolveVersion reads a spec as an exact version, the latest, a range, or a tag", () => {
  // source: "^4.17.0" was read as 4.17.0 and "*" as 0.0.0, so advisories fixed years ago were reported for a project whose install would get a patched version.
  expect(resolveVersion("4.17.21", versionTablePackage)).toEqual({ kind: "exact", version: "4.17.21" });
  expect(resolveVersion(undefined, versionTablePackage)).toEqual({ kind: "latest", version: "4.17.21" });
  expect(resolveVersion("latest", versionTablePackage)).toEqual({ kind: "latest", version: "4.17.21" });
  expect(resolveVersion("*", versionTablePackage)).toEqual({ kind: "latest", version: "4.17.21" });
  expect(resolveVersion("", versionTablePackage)).toEqual({ kind: "latest", version: "4.17.21" });
  expect(resolveVersion("^4.17.0", versionTablePackage)).toEqual({
    kind: "range",
    version: "4.17.21",
    range: "^4.17.0",
  });
  expect(resolveVersion(">=1.0.0", versionTablePackage)).toEqual({
    kind: "range",
    version: "4.17.21",
    range: ">=1.0.0",
  });
  expect(resolveVersion("<2.0.0", versionTablePackage)).toEqual({
    kind: "range",
    version: "1.9.9",
    range: "<2.0.0",
  });
  expect(resolveVersion("next", versionTablePackage)).toEqual({
    kind: "tag",
    version: "5.0.0-beta.1",
    tag: "next",
  });
  expect(resolveVersion("^9.0.0", versionTablePackage)).toEqual({
    kind: "none",
    reason: 'No published version satisfies "^9.0.0".',
  });
  expect(resolveVersion("banana", versionTablePackage)).toEqual({
    kind: "none",
    reason: '"banana" is not a version, a range or a tag of this package.',
  });
});

test("resolveVersion reads a range as the latest version when that version fits", () => {
  // source: a range was read as a version newer than the one npm installs
  const taggedAheadOfLatest = {
    name: "widget",
    version: "4.5.0",
    versions: {
      "4.4.0": {},
      "4.5.0": {},
      "4.6.0": {},
    },
    "dist-tags": { latest: "4.5.0", next: "4.6.0" },
  };
  expect(resolveVersion("^4.0.0", taggedAheadOfLatest)).toEqual({
    kind: "range",
    version: "4.5.0",
    range: "^4.0.0",
  });
  expect(resolveVersion(">4.5.0", taggedAheadOfLatest)).toEqual({
    kind: "range",
    version: "4.6.0",
    range: ">4.5.0",
  });
});

test("check_security asks the advisory API for the resolved version", async () => {
  // source: "^4.17.0" was sent to the advisory API as 4.17.0 and "*" as 0.0.0, and an unknown token was a different error.
  const latest = "4.17.21";
  const registry = {
    "https://registry.npmjs.org/lodash": {
      body: {
        name: "lodash",
        version: latest,
        "dist-tags": { latest, next: "5.0.0-beta.1" },
        versions: {
          "4.17.0": {},
          "4.17.15": {},
          "4.17.21": {},
          "5.0.0-beta.1": {},
        },
      },
    },
  };

  let fetchMock = mockFetch({
    ...registry,
    [affectUrl("lodash", latest)]: { body: [] },
  });
  let rangeRejection: unknown = null;
  let ranged: Awaited<ReturnType<typeof checkSecurity>> | undefined;
  try {
    ranged = await checkSecurity("lodash", "^4.17.0");
  } catch (error) {
    rangeRejection = error;
  }
  expect(rangeRejection).toBeNull();
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("lodash", latest)
  );
  expect(ranged?.resolvedFrom).toBe("range");
  expect(ranged?.checkedVersion).toBe(latest);
  expect(ranged?.recommendation).toBe(
    'No known security advisories affect "lodash" 4.17.21. That is the latest version. The range "^4.17.0" was read as 4.17.21, the version a fresh install would get.'
  );

  fetchMock = mockFetch({
    ...registry,
    [affectUrl("lodash", latest)]: { body: [] },
  });
  let starRejection: unknown = null;
  let star: Awaited<ReturnType<typeof checkSecurity>> | undefined;
  try {
    star = await checkSecurity("lodash", "*");
  } catch (error) {
    starRejection = error;
  }
  expect(starRejection).toBeNull();
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("lodash", latest)
  );
  expect(star?.resolvedFrom).toBe("latest");
  expect(star?.checkedVersion).toBe(latest);
  expect(star?.recommendation).toBe(
    'No known security advisories affect "lodash" 4.17.21. That is the latest version.'
  );

  mockFetch(registry);
  const badVersion = await checkSecurity("lodash", "banana").catch((error: unknown) => error);
  expect(badVersion).toBeInstanceOf(Error);
  expect((badVersion as Error).message).toBe(
    '"banana" is not a version, a range or a tag of this package.'
  );

  fetchMock = mockFetch({
    ...registry,
    [affectUrl("lodash", "5.0.0-beta.1")]: { body: [] },
  });
  let tagRejection: unknown = null;
  let tagged: Awaited<ReturnType<typeof checkSecurity>> | undefined;
  try {
    tagged = await checkSecurity("lodash", "next");
  } catch (error) {
    tagRejection = error;
  }
  expect(tagRejection).toBeNull();
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("lodash", "5.0.0-beta.1")
  );
  expect(tagged?.resolvedFrom).toBe("tag");
  expect(tagged?.recommendation).toBe(
    'No known security advisories affect "lodash" 5.0.0-beta.1. Latest version: 4.17.21. The tag "next" points at 5.0.0-beta.1.'
  );
});

function publishedRegistry(
  name: string,
  latest: string,
  versions: string[],
  advisoryVersion: string
): Record<string, Fixture> {
  return {
    [`https://registry.npmjs.org/${encodeURIComponent(name)}`]: {
      body: {
        name,
        version: latest,
        "dist-tags": { latest },
        versions: Object.fromEntries(versions.map((version) => [version, {}])),
      },
    },
    [`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`]: {
      body: { downloads: 10, package: name },
    },
    [affectUrl(name, advisoryVersion)]: { body: [] },
  };
}

test("analyze_package_json reads a range as the newest version it allows", async () => {
  // source: "^1.2.0" was checked as 1.2.0, so a dependency whose install would get 1.5.0 was called out of date and advisories were looked up for the floor.
  const fetchMock = mockFetch(publishedRegistry("a", "1.5.0", ["1.2.0", "1.5.0"], "1.5.0"));
  let rejection: unknown = null;
  let current: Awaited<ReturnType<typeof analyzePackageJson>> | undefined;
  try {
    current = await analyzePackageJson({ dependencies: { a: "^1.2.0" } });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeNull();
  expect(current?.dependencies[0]).toMatchObject({
    name: "a",
    current: "1.5.0",
    latest: "1.5.0",
    status: "up-to-date",
    spec: "^1.2.0",
    resolvedFrom: "range",
  });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toContain(affectUrl("a", "1.5.0"));
  expect(urls).not.toContain(affectUrl("a", "1.2.0"));
  expect(current?.summary).toContain(
    "Ranges and tags were read as a fresh install would resolve them. A lockfile may hold an older version."
  );

  const majorMock = mockFetch(publishedRegistry("a", "2.0.0", ["1.2.0", "1.5.0", "2.0.0"], "1.5.0"));
  let majorRejection: unknown = null;
  let behind: Awaited<ReturnType<typeof analyzePackageJson>> | undefined;
  try {
    behind = await analyzePackageJson({ dependencies: { a: "^1.2.0" } });
  } catch (error) {
    majorRejection = error;
  }
  expect(majorRejection).toBeNull();
  expect(behind?.dependencies[0]).toMatchObject({
    name: "a",
    current: "1.5.0",
    latest: "2.0.0",
    status: "major",
    spec: "^1.2.0",
    resolvedFrom: "range",
  });
  expect(String(majorMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("a", "1.5.0")
  );
  expect(behind?.summary).toContain(
    "Ranges and tags were read as a fresh install would resolve them. A lockfile may hold an older version."
  );
});

test("analyze_package_json reads latest and star as the latest version", async () => {
  // source: "latest" and "*" were not compared, so advisories for the version a fresh install would get were skipped.
  const fetchMock = mockFetch({
    ...dependencyFixtures("b", "2.0.0", "2.0.0"),
    ...dependencyFixtures("c", "3.1.0", "3.1.0"),
  });
  let rejection: unknown = null;
  let result: Awaited<ReturnType<typeof analyzePackageJson>> | undefined;
  try {
    result = await analyzePackageJson({ dependencies: { b: "latest", c: "*" } });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeNull();
  expect(result?.dependencies).toMatchObject([
    { name: "b", current: "2.0.0", spec: "latest", resolvedFrom: "latest", status: "up-to-date", securityIssues: 0 },
    { name: "c", current: "3.1.0", spec: "*", resolvedFrom: "latest", status: "up-to-date", securityIssues: 0 },
  ]);
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toContain(affectUrl("b", "2.0.0"));
  expect(urls).toContain(affectUrl("c", "3.1.0"));
});

test("analyze_package_json names a rate limit in the summary", async () => {
  // source: a rate-limited advisory lookup was only a per-package error, so the summary never said to set GITHUB_TOKEN.
  mockFetch({
    ...registryDownloads("lodash", "4.17.21"),
    [affectUrl("lodash", "4.17.21")]: { status: 403, body: {} },
  });
  let rejection: unknown = null;
  let result: Awaited<ReturnType<typeof analyzePackageJson>> | undefined;
  try {
    result = await analyzePackageJson({ dependencies: { lodash: "4.17.21" } });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeNull();
  expect(result?.summary).toContain(
    "GitHub's rate limit was reached. Set GITHUB_TOKEN and run it again for the missing advisory counts."
  );
});

test("analyze_package_json lists at most three deprecated dependencies", async () => {
  // source: every deprecated dependency was added to top priorities, so five deprecated packages produced five lines.
  const names = ["old-a", "old-b", "old-c", "old-d", "old-e"];
  const dependencies: Record<string, string> = {};
  const fixtures: Record<string, Fixture> = {};
  for (const name of names) {
    dependencies[name] = "1.0.0";
    fixtures[`https://registry.npmjs.org/${name}`] = {
      body: {
        name,
        version: "1.0.0",
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { deprecated: "no longer maintained" } },
      },
    };
    fixtures[`https://api.npmjs.org/downloads/point/last-week/${name}`] = {
      body: { downloads: 1, package: name },
    };
    fixtures[affectUrl(name, "1.0.0")] = { body: [] };
  }
  mockFetch(fixtures);
  let rejection: unknown = null;
  let result: Awaited<ReturnType<typeof analyzePackageJson>> | undefined;
  try {
    result = await analyzePackageJson({ dependencies });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeNull();
  expect(result?.topPriorities.filter((line) => line.endsWith("is deprecated on npm"))).toEqual([
    "old-a is deprecated on npm",
    "old-b is deprecated on npm",
    "old-c is deprecated on npm",
  ]);
  expect(result?.summary).toContain("5 deprecated.");
});

test("research_package uses the newest version in range and says when a version cannot be read", async () => {
  // source: "^1.2.3" was checked at its floor, and an unreadable version did not say that advisories were checked for the latest.
  const versions = ["1.2.3", "1.4.0", "1.9.0", "2.0.0"];
  function widget(advisoryVersion: string, tags: Record<string, string> = { latest: "2.0.0" }): Record<string, Fixture> {
    return {
      "https://registry.npmjs.org/widget": {
        body: {
          name: "widget",
          version: "2.0.0",
          "dist-tags": tags,
          versions: Object.fromEntries(versions.map((version) => [version, {}])),
        },
      },
      "https://api.npmjs.org/downloads/point/last-week/widget": { body: { downloads: 10, package: "widget" } },
      "https://api.npmjs.org/downloads/point/last-month/widget": { body: { downloads: 40, package: "widget" } },
      [affectUrl("widget", advisoryVersion)]: { body: [] },
    };
  }

  let fetchMock = mockFetch(widget("1.9.0"));
  let rangeRejection: unknown = null;
  let ranged: Awaited<ReturnType<typeof researchPackage>> | undefined;
  try {
    ranged = await researchPackage("widget", "^1.2.3");
  } catch (error) {
    rangeRejection = error;
  }
  expect(rangeRejection).toBeNull();
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("widget", "1.9.0")
  );
  expect(ranged?.security.checkedVersion).toBe("1.9.0");
  expect(ranged?.versionsBehind).toBe(1);
  expect(ranged?.versionNote).toBe(
    'The range "^1.2.3" was read as 1.9.0, the version a fresh install would get.'
  );

  fetchMock = mockFetch(widget("2.0.0"));
  let bananaRejection: unknown = null;
  let banana: Awaited<ReturnType<typeof researchPackage>> | undefined;
  try {
    banana = await researchPackage("widget", "banana");
  } catch (error) {
    bananaRejection = error;
  }
  expect(bananaRejection).toBeNull();
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("widget", "2.0.0")
  );
  expect(banana?.security.checkedVersion).toBe("2.0.0");
  expect(banana?.versionNote).toBe(
    '"banana" is not a version, a range or a tag of this package. Advisories were checked for the latest version, 2.0.0.'
  );
  expect(banana !== undefined && "versionsBehind" in banana).toBe(false);

  fetchMock = mockFetch(widget("1.4.0", { latest: "2.0.0", next: "1.4.0" }));
  let tagRejection: unknown = null;
  let tagged: Awaited<ReturnType<typeof researchPackage>> | undefined;
  try {
    tagged = await researchPackage("widget", "next");
  } catch (error) {
    tagRejection = error;
  }
  expect(tagRejection).toBeNull();
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("widget", "1.4.0")
  );
  expect(tagged?.versionNote).toBe('The tag "next" points at 1.4.0.');
  expect(tagged?.versionsBehind).toBe(2);
});

test("unknown tool arguments are refused", async () => {
  // source: a removed framework or category argument, or a typo, was silently ignored.
  const cases: Array<{ name: string; arguments: Record<string, unknown>; key: string }> = [
    { name: "research_package", arguments: { package: "left-pad", currentVerison: "1" }, key: "currentVerison" },
    { name: "compare_packages", arguments: { packages: ["a", "b"], extra: true }, key: "extra" },
    { name: "find_alternatives", arguments: { package: "lodash", category: "ui" }, key: "category" },
    { name: "check_security", arguments: { package: "lodash", framework: "react" }, key: "framework" },
    { name: "analyze_package_json", arguments: { packageJson: { name: "app" }, typo: 1 }, key: "typo" },
    { name: "exa_deep_search", arguments: { query: "q", unknown: true }, key: "unknown" },
    { name: "exa_research", arguments: { instructions: "q", unknown: true }, key: "unknown" },
    { name: "get_trending", arguments: { category: "testing", framework: "react" }, key: "framework" },
  ];
  for (const toolCase of cases) {
    let rejection: unknown = null;
    let result: Awaited<ReturnType<typeof handleToolCall>> | undefined;
    try {
      result = await handleToolCall({ params: { name: toolCase.name, arguments: toolCase.arguments } });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeNull();
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toBe(
      `Invalid arguments for ${toolCase.name}: ${toolCase.key}: Unrecognized key`
    );
  }
});

test("each advisory page gets its own timeout signal, and a timed out body is not an unexpected body", async () => {
  // source: one 15 second timer was shared across advisory pages, and a timeout while reading the body was reported as an unexpected response body.
  const first = affectUrl("lodash", "4.17.21");
  const next = `${first}&page=2`;
  const fetchMock = mockFetch({
    [first]: { body: [], headers: { Link: `<${next}>; rel="next"` } },
    [next]: { body: [] },
  });
  let pageRejection: unknown = null;
  try {
    await checkSecurityAdvisories("lodash", "4.17.21");
  } catch (error) {
    pageRejection = error;
  }
  expect(pageRejection).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal;
  const secondSignal = fetchMock.mock.calls[1]?.[1]?.signal;
  expect(firstSignal).toBeInstanceOf(AbortSignal);
  expect(secondSignal).toBeInstanceOf(AbortSignal);
  expect(firstSignal).not.toBe(secondSignal);

  const timedOut = new Response(new ReadableStream({
    start(controller) {
      controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    },
  }));
  mockFetch({ [first]: timedOut });
  const error = await checkSecurityAdvisories("lodash", "4.17.21").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AdvisoryLookupError);
  expect(error).toMatchObject({
    message: "GitHub advisory lookup failed for lodash: the request timed out",
  });
});

function comparedPackage(name: string, downloads: number, stars: number): Record<string, Fixture> {
  return {
    ...packageBundle(name, {
      name,
      version: "1.0.0",
      "dist-tags": { latest: "1.0.0" },
      repository: `https://github.com/acme/${name}`,
    }, downloads),
    [`https://api.github.com/repos/acme/${name}`]: {
      body: {
        name,
        full_name: `acme/${name}`,
        description: null,
        stargazers_count: stars,
        forks_count: 0,
        open_issues_count: 0,
        license: null,
        pushed_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        archived: false,
        disabled: false,
      },
    },
  };
}

test("compare_packages does not crown one package and keeps a failed read in the result", async () => {
  // source: a single count was called the most, a tie was called a winner, and an unexpected error while reading one package rejected the whole comparison.
  mockFetch({
    ...comparedPackage("solo", 5000, 12),
    "https://registry.npmjs.org/gone": { status: 404, body: {} },
  });
  let singleRejection: unknown = null;
  let single: Awaited<ReturnType<typeof comparePackages>> | undefined;
  try {
    single = await comparePackages(["solo", "gone"]);
  } catch (error) {
    singleRejection = error;
  }
  expect(singleRejection).toBeNull();
  expect(single?.recommendation ?? "").not.toContain("has the most");
  expect(single?.recommendation ?? "").not.toContain("have the same");
  expect(single?.recommendation).toBe("Not found on npm: gone.");

  mockFetch({
    ...comparedPackage("alpha", 1000, 40),
    ...comparedPackage("beta", 1000, 40),
  });
  let tieRejection: unknown = null;
  let tied: Awaited<ReturnType<typeof comparePackages>> | undefined;
  try {
    tied = await comparePackages(["alpha", "beta"]);
  } catch (error) {
    tieRejection = error;
  }
  expect(tieRejection).toBeNull();
  expect(tied?.recommendation).toBe(
    '"alpha" and "beta" have the same weekly downloads (1,000). "alpha" and "beta" have the same GitHub stars (40).'
  );

  mockFetch({
    "https://registry.npmjs.org/broken": {
      body: { version: "1.0.0", "dist-tags": { latest: "1.0.0" } },
    },
    "https://api.npmjs.org/downloads/point/last-week/broken": { body: { downloads: 1, package: "broken" } },
    ...packageBundle("kept", { name: "kept", version: "1.2.0", "dist-tags": { latest: "1.2.0" } }, 8),
  });
  let failedRejection: unknown = null;
  let failed: Awaited<ReturnType<typeof comparePackages>> | undefined;
  try {
    failed = await comparePackages(["broken", "kept"]);
  } catch (error) {
    failedRejection = error;
  }
  expect(failedRejection).toBeNull();
  const broken = failed?.packages.find((pkg) => pkg.name === "broken");
  expect(broken?.status).toBe("lookup-failed");
  expect(typeof broken?.error).toBe("string");
  expect((broken?.error ?? "").length > 0).toBe(true);
  expect(failed?.packages.find((pkg) => pkg.name === "kept")?.status).toBe("found");
});

test("parseGitHubRepo rejects dot and dotdot path segments", () => {
  // source: an owner or repository named "." or ".." was parsed as a GitHub repository.
  expect(parseGitHubRepo("https://github.com/owner/..")).toBeNull();
  expect(parseGitHubRepo("https://github.com/./repo")).toBeNull();
});

test("find_alternatives returns fresh pros and cons arrays", async () => {
  // source: changing the pros array of one find_alternatives result changed the next answer.
  function altBundle(name: string, downloads: number): Record<string, Fixture> {
    const encoded = encodeURIComponent(name);
    return {
      [`https://registry.npmjs.org/${encoded}`]: {
        body: { name, version: "1.0.0", "dist-tags": { latest: "1.0.0" }, description: name },
      },
      [`https://api.npmjs.org/downloads/point/last-week/${encoded}`]: {
        body: { downloads, package: name },
      },
    };
  }
  mockFetch({
    ...altBundle("date-fns", 300),
    ...altBundle("dayjs", 200),
    ...altBundle("luxon", 100),
  });
  let firstRejection: unknown = null;
  let first: Awaited<ReturnType<typeof findAlternatives>> | undefined;
  try {
    first = await findAlternatives("moment");
  } catch (error) {
    firstRejection = error;
  }
  expect(firstRejection).toBeNull();
  const firstPros = first?.alternatives.find((item) => item.name === "dayjs")?.pros;
  expect(firstPros).toEqual(["API modeled on Moment", "Immutable date objects", "Features are added through plugins"]);
  firstPros?.push("changed by the caller");
  let secondRejection: unknown = null;
  let second: Awaited<ReturnType<typeof findAlternatives>> | undefined;
  try {
    second = await findAlternatives("moment");
  } catch (error) {
    secondRejection = error;
  }
  expect(secondRejection).toBeNull();
  expect(second?.alternatives.find((item) => item.name === "dayjs")?.pros).toEqual([
    "API modeled on Moment",
    "Immutable date objects",
    "Features are added through plugins",
  ]);
});

test("isRegistrySpec refuses paths, URLs, ssh addresses, GitHub shorthand and protocol prefixes", () => {
  // source: user/repo, a relative or absolute path, git@ and ssh:// were sent to the npm registry by name.
  const refused = [
    "user/repo",
    "user/repo#main",
    "user/repo#feature/x",
    "user/repo#semver:^1.0.0",
    "user/repo#v1.2.3",
    ".",
    "..",
    "./pkg",
    "./a/b",
    "../pkg",
    "../../pkg",
    "/abs/pkg",
    "/abs/a/b",
    "~/pkg",
    "~/a/b",
    "git@github.com:user/repo.git",
    "git@gitlab.example.test:group/sub/repo.git",
    "ssh://git@github.com/user/repo.git",
    "workspace:*",
    "npm:left-pad@1.0.0",
    "file:../local",
    "link:../pkg",
    "git+https://github.com/acme/pkg.git",
    "git://github.com/acme/pkg.git",
    "github:acme/pkg",
    "gitlab:acme/pkg",
    "bitbucket:acme/pkg",
    "http://example.com/pkg.tgz",
    "https://example.com/pkg.tgz",
  ];
  for (const spec of refused) {
    expect(isRegistrySpec(spec)).toBe(false);
  }
  const accepted = [
    "1.2.3",
    "1.0.0 - 2.0.0",
    "^1.2.3",
    ">=1 <2",
    "latest",
    "next",
    "*",
    "",
    "1.x",
    "~1.2.3",
    "~1",
    "~1.2.x",
    "~0.0.1",
  ];
  for (const spec of accepted) {
    expect(isRegistrySpec(spec)).toBe(true);
  }
});

test("analyze_package_json looks up a tilde range", async () => {
  // source: a tilde range was taken for a file path and not looked up
  const pkg = {
    name: "a",
    version: "1.3.0",
    "dist-tags": { latest: "1.3.0" },
    versions: {
      "1.2.0": {},
      "1.2.9": {},
      "1.3.0": {},
    },
  };
  const fetchMock = mockFetch({
    "https://registry.npmjs.org/a": { body: pkg },
    "https://api.npmjs.org/downloads/point/last-week/a": {
      body: { downloads: 10, package: "a" },
    },
    [affectUrl("a", "1.2.9")]: { body: [] },
  });
  let rejection: unknown = null;
  let result: Awaited<ReturnType<typeof analyzePackageJson>> | undefined;
  try {
    result = await analyzePackageJson({ dependencies: { a: "~1.2.0" } });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeNull();
  const dependency = result?.dependencies.find((dep) => dep.name === "a");
  expect(dependency).toMatchObject({
    resolvedFrom: "range",
    current: "1.2.9",
    status: "minor",
  });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toContain("https://registry.npmjs.org/a");
  expect(urls).toContain(affectUrl("a", "1.2.9"));
  expect(resolveVersion("~1.2.0", pkg)).toMatchObject({
    kind: "range",
    version: "1.2.9",
  });
});

test("analyze_package_json does not look up a GitHub shorthand with a slash in the branch", async () => {
  // source: a GitHub shorthand with a slash in its branch name was sent to the registry
  const fetchMock = mockFetch({});
  const result = await analyzePackageJson({
    dependencies: { a: "user/repo#feature/x" },
  });
  expect(fetchMock.mock.calls.length).toBe(0);
  const dependency = result.dependencies.find((dep) => dep.name === "a");
  expect(dependency?.status).toBe("unknown");
  expect(dependency?.recommendation).toBe(
    'Version spec "user/repo#feature/x" does not point at an npm registry version, so it was not looked up.'
  );
});

test("analyze_package_json does not look up a GitHub shorthand or a relative path", async () => {
  // source: "user/repo" and "../local" were fetched from the registry by package name.
  const fetchMock = mockFetch({});
  const result = await analyzePackageJson({
    dependencies: { a: "user/repo", b: "../local" },
  });
  expect(fetchMock.mock.calls.length).toBe(0);
  expect(result.dependencies).toEqual([
    {
      name: "a",
      spec: "user/repo",
      current: "user/repo",
      status: "unknown",
      securityIssues: null,
      recommendation:
        'Version spec "user/repo" does not point at an npm registry version, so it was not looked up.',
    },
    {
      name: "b",
      spec: "../local",
      current: "../local",
      status: "unknown",
      securityIssues: null,
      recommendation:
        'Version spec "../local" does not point at an npm registry version, so it was not looked up.',
    },
  ]);
});

test("resolveVersion uses latest when the versions map is missing and latest satisfies the range", () => {
  // source: a range was unknown when the registry omitted the versions map, even though latest satisfied it.
  const pkg = {
    name: "plain",
    version: "2.1.0",
    "dist-tags": { latest: "2.1.0" },
  };
  expect(resolveVersion("^2.0.0", pkg)).toEqual({
    kind: "range",
    version: "2.1.0",
    range: "^2.0.0",
  });
});

test("research_package treats a whitespace currentVersion as omitted", async () => {
  // source: a currentVersion of only whitespace produced versionsBehind and a version note.
  mockFetch({
    "https://registry.npmjs.org/plain": {
      body: {
        name: "plain",
        version: "2.1.0",
        "dist-tags": { latest: "2.1.0" },
        versions: { "1.0.0": {}, "2.0.0": {}, "2.1.0": {} },
      },
    },
    "https://api.npmjs.org/downloads/point/last-week/plain": { body: { downloads: 1, package: "plain" } },
    "https://api.npmjs.org/downloads/point/last-month/plain": { body: { downloads: 4, package: "plain" } },
    [affectUrl("plain", "2.1.0")]: { body: [] },
  });
  const result = await researchPackage("plain", "   ");
  expect(result.versionsBehind).toBeUndefined();
  expect("versionsBehind" in result).toBe(false);
  expect(result.versionNote).toBeUndefined();
  expect("versionNote" in result).toBe(false);
});

test("research_package treats an empty currentVersion as omitted", async () => {
  // source: an empty currentVersion produced versionsBehind and a version note.
  mockFetch({
    "https://registry.npmjs.org/plain": {
      body: {
        name: "plain",
        version: "2.1.0",
        "dist-tags": { latest: "2.1.0" },
        versions: { "1.0.0": {}, "2.0.0": {}, "2.1.0": {} },
      },
    },
    "https://api.npmjs.org/downloads/point/last-week/plain": { body: { downloads: 1, package: "plain" } },
    "https://api.npmjs.org/downloads/point/last-month/plain": { body: { downloads: 4, package: "plain" } },
    [affectUrl("plain", "2.1.0")]: { body: [] },
  });
  const result = await researchPackage("plain", "");
  expect(result.versionsBehind).toBeUndefined();
  expect("versionsBehind" in result).toBe(false);
  expect(result.versionNote).toBeUndefined();
  expect("versionNote" in result).toBe(false);
});

test("compare_packages names every package in a three-way download tie", async () => {
  // source: three packages with the same weekly downloads were described as only the first two.
  mockFetch({
    ...comparedPackage("a", 1000, 1),
    ...comparedPackage("b", 1000, 2),
    ...comparedPackage("c", 1000, 3),
  });
  const result = await comparePackages(["a", "b", "c"]);
  expect(result.recommendation).toContain(
    '"a", "b" and "c" have the same weekly downloads (1,000).'
  );
});

test("cliEntryMatches accepts an entry path that omits .js", () => {
  // source: node dist/index did not match dist/index.js, so the server did not start.
  const root = mkdtempSync(join(tmpdir(), "eco-cli-js-"));
  try {
    const entry = join(root, "index.js");
    writeFileSync(entry, "");
    expect(cliEntryMatches(entry, join(root, "index"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cliEntryMatches treats a directory entry as its index.js", () => {
  // source: node dist compared the folder with dist/index.js and did not start the server.
  const root = mkdtempSync(join(tmpdir(), "eco-cli-"));
  try {
    const dir = join(root, "dist");
    mkdirSync(dir);
    const indexFile = join(dir, "index.js");
    writeFileSync(indexFile, "");
    const fileEntry = join(root, "other.js");
    writeFileSync(fileEntry, "");
    expect(cliEntryMatches(indexFile, dir)).toBe(true);
    expect(cliEntryMatches(fileEntry, fileEntry)).toBe(true);
    expect(cliEntryMatches(indexFile, fileEntry)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
