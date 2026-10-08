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
import { handleToolCall, tools } from "../src/index.js";

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

test('analyze_package_json does not call ^1.2, latest, or workspace:* up to date', async () => {
  // source: a range or tag was reported up to date, and the summary could say all packages were.
  mockFetch({
    ...dependencyFixtures("a", "1.5.0", "1.2.0"),
    ...registryDownloads("b", "9.0.0"),
    ...dependencyFixtures("d", "1.0.0", "1.0.0"),
  });

  const result = await analyzePackageJson({
    dependencies: { a: "^1.2.0", b: "latest", c: "workspace:*", d: "1.0.0" },
  });
  expect(result.dependencies).toMatchObject([
    { name: "a", current: "1.2.0", latest: "1.5.0", status: "minor" },
    {
      name: "b",
      status: "unknown",
      securityIssues: null,
      recommendation: 'Version spec "latest" is not a plain version or range, so it was not compared and its advisories were not checked.',
    },
    {
      name: "c",
      status: "unknown",
      securityIssues: null,
      recommendation: 'Version spec "workspace:*" does not point at an npm registry version, so it was not looked up.',
    },
    { name: "d", current: "1.0.0", latest: "1.0.0", status: "up-to-date" },
  ]);
  expect(result.summary).not.toContain("All packages are up to date.");
  expect(result.dependencies.filter((dep) => dep.status === "up-to-date").map((dep) => dep.name)).toEqual(["d"]);
});

test("star, empty, and protocol specs are not reported up to date", async () => {
  // source: *, empty, and npm/git/http/file/link specs were compared as if they were versions.
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
    Object.assign(fixtures, registryDownloads(name, "1.0.0"));
  }
  mockFetch(fixtures);

  const result = await analyzePackageJson({ dependencies: specs });
  const registrySpecs = new Set(["star", "blank"]);
  for (const dep of result.dependencies) {
    expect(dep.status).toBe("unknown");
    if (registrySpecs.has(dep.name)) {
      expect(dep.recommendation).toBe(
        `Version spec "${specs[dep.name]}" is not a plain version or range, so it was not compared and its advisories were not checked.`
      );
    } else {
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

test("hyphen, space, and x-ranges compare from the minimum version", async () => {
  // source: only a leading ^ or ~ was stripped, so other ranges were not compared from semver.minVersion.
  mockFetch({
    ...dependencyFixtures("hyphen", "2.1.0", "1.2.3"),
    ...dependencyFixtures("space", "1.9.0", "1.2.3"),
    ...dependencyFixtures("xrange", "1.5.0", "1.0.0"),
  });

  const result = await analyzePackageJson({
    dependencies: {
      hyphen: "1.2.3 - 2.0.0",
      space: ">=1.2.3 <2.0.0",
      xrange: "1.x",
    },
  });
  expect(result.dependencies).toMatchObject([
    { name: "hyphen", current: "1.2.3", status: "major" },
    { name: "space", current: "1.2.3", status: "minor" },
    { name: "xrange", current: "1.0.0", status: "minor" },
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
  expect(ranged.versionNote).toBeUndefined();
  expect(ranged.typescript).toBe(true);
  expect(ranged.versionsBehind).toBe(1);

  const tagged = await researchPackage("zod", "latest");
  expect(tagged.versionNote).toBe('The version "latest" could not be compared.');
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
    ...registryLatest("lodash", latest),
    [affectUrl("lodash", "4.17.0")]: { body: [] },
  });
  const ranged = await checkSecurity("lodash", "^4.17.0");
  expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes("advisories"))?.[0])).toBe(
    affectUrl("lodash", "4.17.0")
  );
  expect(ranged.checkedVersion).toBe("4.17.0");
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
    'Version "banana" is not a version or range that can be checked.'
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
    [affectUrl("steps", "1.0.5")]: { body: [] },
    [affectUrl("steps", "2.0.0")]: { body: [] },
  };
  mockFetch(fixtures);

  expect((await researchPackage("steps", "1.0.0")).versionsBehind).toBe(2);
  expect((await researchPackage("steps", "2.0.0")).versionsBehind).toBe(0);
  expect((await researchPackage("steps", "^1.0.5")).versionsBehind).toBe(2);
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
    '"beta" has the most weekly downloads (2,500). "alpha" has the most GitHub stars (40). GitHub stars were not available for: beta.'
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

test("a latest dependency skips the advisory lookup", async () => {
  // source: a latest tag was sent to the advisory API and a failed or skipped lookup was counted as zero.
  const fetchMock = mockFetch(registryDownloads("tagged", "2.0.0"));
  const result = await analyzePackageJson({ dependencies: { tagged: "latest" } });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls.some((url) => url.includes("advisories"))).toBe(false);
  expect(result.dependencies[0]?.securityIssues).toBeNull();
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

test("weekly downloads against a monthly average choose rising, stable, or unknown", async () => {
  // source: the trend label divided the month by 4, and a missing month was called stable.
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
    ...point("ajv", 10, 40),
    ...point("joi", 10, 40),
    ...point("superstruct", 10, 40),
  });
  const result = await getTrending("validation");
  const label = (name: string) => result.packages.find((pkg) => pkg.name === name)?.trending;
  expect(label("zod")).toBe("rising");
  expect(label("yup")).toBe("stable");
  expect(label("valibot")).toBe("unknown");
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
    expect(tool.description ?? "").not.toContain("Bundle");
    expect(tool.description ?? "").not.toContain("Deprecated packages");
  }
  const trending = tools.find((tool) => tool.name === "get_trending");
  const alternatives = tools.find((tool) => tool.name === "find_alternatives");
  const trendingSchema = trending?.inputSchema as { properties?: Record<string, unknown> };
  const alternativesSchema = alternatives?.inputSchema as { properties?: Record<string, unknown> };
  expect(Object.keys(trendingSchema.properties ?? {})).toEqual(["category"]);
  expect(Object.keys(alternativesSchema.properties ?? {})).toEqual(["package"]);
  expect(Object.keys(trendingSchema.properties ?? {})).not.toContain("framework");
  expect(Object.keys(alternativesSchema.properties ?? {})).not.toContain("category");
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
      ...registryLatest("lodash", "4.17.21"),
      [affectUrl("lodash", "4.17.0")]: { body: [] },
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
      ...registryDownloads("b", "9.0.0"),
      ...dependencyFixtures("d", "1.0.0", "1.0.0"),
    },
    () => analyzePackageJson({
      dependencies: { a: "^1.2.0", b: "latest", c: "workspace:*", d: "1.0.0" },
    })
  );
  const specFixtures: Record<string, Fixture> = {};
  for (const name of ["star", "blank"]) Object.assign(specFixtures, registryDownloads(name, "1.0.0"));
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
      ...dependencyFixtures("xrange", "1.5.0", "1.0.0"),
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
