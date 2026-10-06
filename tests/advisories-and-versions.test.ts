import { afterEach, expect, mock, test } from "bun:test";
import { analyzePackageJson } from "../src/tools/analyze-package-json.js";
import { checkSecurity } from "../src/tools/check-security.js";
import { fetchPackageData } from "../src/tools/npm-client.js";
import { researchPackage } from "../src/tools/research-package.js";
import {
  AdvisoryLookupError,
  checkSecurityAdvisories,
} from "../src/tools/security-client.js";

type Fixture = {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
} | Error | Response;

const originalFetch = globalThis.fetch;
let unexpectedRequests: string[] = [];
const lodashUrl = "https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=lodash";
const zodUrl = "https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=zod";

function mockFetch(fixtures: Record<string, Fixture>) {
  const fetchMock = mock(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
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

function advisory(id: string, packageName = "lodash") {
  return {
    ghsa_id: id,
    severity: "HIGH",
    summary: "Example vulnerability",
    description: "Example description",
    cve_id: "CVE-2020-8203",
    published_at: "2020-07-15T00:00:00Z",
    html_url: `https://github.com/advisories/${id}`,
    vulnerabilities: [{
      package: { name: packageName, ecosystem: "npm" },
      vulnerable_version_range: "< 4.17.21",
      patched_versions: ">= 4.17.21",
    }],
  };
}

function registryFixtures(packageName: string, latest: string): Record<string, Fixture> {
  return {
    [`https://registry.npmjs.org/${packageName}`]: {
      body: { name: packageName, "dist-tags": { latest } },
    },
    [`https://api.npmjs.org/downloads/point/last-week/${packageName}`]: {
      body: { downloads: 100, package: packageName },
    },
  };
}

function researchFixtures(): Record<string, Fixture> {
  return {
    ...registryFixtures("zod", "4.0.0"),
    "https://registry.npmjs.org/zod": {
      body: {
        name: "zod",
        "dist-tags": { latest: "4.0.0" },
        versions: { "3.0.0": {}, "3.1.0": {}, "4.0.0": {} },
        time: {
          "3.0.0": "2024-01-01T00:00:00Z",
          "3.1.0": "2024-06-01T00:00:00Z",
          "4.0.0": "2025-01-01T00:00:00Z",
        },
      },
    },
    "https://api.npmjs.org/downloads/point/last-month/zod": {
      body: { downloads: 400, package: "zod" },
    },
  };
}

test("advisory requests filter by package with affects", async () => {
  // source: GitHub ignores the package query parameter and returns unrelated advisories.
  const fetchMock = mockFetch({ [lodashUrl]: { body: [] } });

  expect(await checkSecurityAdvisories("lodash")).toEqual([]);
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toContain("affects=lodash");
  expect(url).toContain("per_page=100");
  expect(url).not.toContain("package=");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const headers = fetchMock.mock.calls[0][1]?.headers;
  expect(headers).toMatchObject({
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ecosystem-mcp",
  });
});

test("advisory requests include the version in affects", async () => {
  // source: The old client-side version filter returned every advisory.
  const url = `${lodashUrl}%404.17.21`;
  const fetchMock = mockFetch({ [url]: { body: [] } });

  expect(await checkSecurityAdvisories("lodash", "4.17.21")).toEqual([]);
  expect(fetchMock.mock.calls[0][0]).toBe(url);
});

test("advisory requests encode scoped package names and versions", async () => {
  // source: The affects filter must preserve scoped names and the requested version.
  const url = "https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=%40scope%2Fpkg%401.0.0";
  const fetchMock = mockFetch({ [url]: { body: [] } });

  expect(await checkSecurityAdvisories("@scope/pkg", "1.0.0")).toEqual([]);
  expect(fetchMock.mock.calls[0][0]).toBe(url);
});

test("advisory ranges come from the matching npm vulnerability", async () => {
  // source: The first vulnerability entry can describe a different package or ecosystem.
  const matching = advisory("GHSA-matching");
  matching.vulnerabilities.unshift(
    { package: { name: "lodash-es", ecosystem: "npm" }, vulnerable_version_range: "< 1.0.0", patched_versions: "1.0.0" },
    { package: { name: "lodash", ecosystem: "pip" }, vulnerable_version_range: "< 2.0.0", patched_versions: "2.0.0" }
  );
  const wrongEcosystem = advisory("GHSA-other-ecosystem");
  wrongEcosystem.vulnerabilities[0].package.ecosystem = "pip";
  mockFetch({
    [lodashUrl]: { body: [matching, advisory("GHSA-other", "lodash-es"), wrongEcosystem] },
  });

  expect(await checkSecurityAdvisories("lodash")).toEqual([{
    id: "GHSA-matching",
    severity: "high",
    title: "Example vulnerability",
    description: "Example description",
    cve: "CVE-2020-8203",
    patchedVersions: ">= 4.17.21",
    vulnerableVersions: "< 4.17.21",
    publishedAt: "2020-07-15T00:00:00Z",
    url: "https://github.com/advisories/GHSA-matching",
  }]);
});

test("HTTP advisory failures throw a named error", async () => {
  // source: A failed advisory lookup must not appear to have no advisories.
  mockFetch({ [lodashUrl]: { status: 403, body: { message: "Forbidden" } } });

  const error = await checkSecurityAdvisories("lodash").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AdvisoryLookupError);
  expect(error).toMatchObject({
    name: "AdvisoryLookupError",
    message: "GitHub advisory lookup failed for lodash: HTTP 403",
  });
});

test("non-array advisory bodies throw a lookup error", async () => {
  // source: An unexpected advisory response body must not appear to have no advisories.
  mockFetch({ [lodashUrl]: { body: { message: "Unexpected object" } } });

  await expect(checkSecurityAdvisories("lodash")).rejects.toThrow(
    new AdvisoryLookupError("GitHub advisory lookup failed for lodash: unexpected response body")
  );
});

test("fetch rejections become advisory lookup errors", async () => {
  // source: A rejected advisory fetch was swallowed and reported as an empty result.
  mockFetch({ [lodashUrl]: new Error("Connection failed") });

  const error = await checkSecurityAdvisories("lodash").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AdvisoryLookupError);
  expect(error).toMatchObject({ message: "GitHub advisory lookup failed for lodash: Connection failed" });
});

test("invalid JSON advisory bodies throw an unexpected response error", async () => {
  // source: A response that cannot be parsed as a JSON array must expose the unexpected body failure.
  mockFetch({ [lodashUrl]: new Response("invalid JSON") });

  await expect(checkSecurityAdvisories("lodash")).rejects.toThrow(
    new AdvisoryLookupError("GitHub advisory lookup failed for lodash: unexpected response body")
  );
});

test("check_security propagates advisory lookup failures", async () => {
  // source: check_security must return an error instead of claiming there are no advisories.
  mockFetch({
    ...registryFixtures("lodash", "4.17.21"),
    [lodashUrl]: { status: 403, body: {} },
  });

  const error = await checkSecurity("lodash").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AdvisoryLookupError);
  expect(error).toMatchObject({ message: "GitHub advisory lookup failed for lodash: HTTP 403" });
});

test("advisory pagination follows the next link", async () => {
  // source: Advisory lookups must include advisories beyond the first page.
  const nextUrl = `${lodashUrl}&page=2`;
  const fetchMock = mockFetch({
    [lodashUrl]: {
      body: [advisory("GHSA-first")],
      headers: { Link: `<${nextUrl}>; rel="next", <${nextUrl}>; rel="last"` },
    },
    [nextUrl]: {
      body: [advisory("GHSA-second")],
      headers: { Link: `<${lodashUrl}>; rel="prev"` },
    },
  });

  expect((await checkSecurityAdvisories("lodash")).map((item) => item.id))
    .toEqual(["GHSA-first", "GHSA-second"]);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([lodashUrl, nextUrl]);
  expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
});

test("advisory pagination stops after ten pages", async () => {
  // source: The advisory pagination limit must prevent unbounded requests.
  const fixtures: Record<string, Fixture> = {};
  for (let page = 1; page <= 10; page++) {
    const url = page === 1 ? lodashUrl : `${lodashUrl}&page=${page}`;
    fixtures[url] = {
      body: [advisory(`GHSA-page-${page}`)],
      headers: { Link: `<${lodashUrl}&page=${page + 1}>; rel="next"` },
    };
  }
  const fetchMock = mockFetch(fixtures);

  expect(await checkSecurityAdvisories("lodash")).toHaveLength(10);
  expect(fetchMock).toHaveBeenCalledTimes(10);
});

test("a later advisory page failure rejects the whole lookup", async () => {
  // source: Incomplete advisory results must not hide a failed page lookup.
  const nextUrl = `${lodashUrl}&page=2`;
  mockFetch({
    [lodashUrl]: { body: [advisory("GHSA-first")], headers: { Link: `<${nextUrl}>; rel="next"` } },
    [nextUrl]: { status: 403, body: {} },
  });

  await expect(checkSecurityAdvisories("lodash")).rejects.toThrow(
    new AdvisoryLookupError("GitHub advisory lookup failed for lodash: HTTP 403")
  );
});

test("registry latest dist-tag supplies a missing top-level version", async () => {
  // source: Registry documents usually lack the top-level version consumed by package tools.
  mockFetch(registryFixtures("lodash", "4.17.21"));

  expect(await fetchPackageData("lodash")).toEqual({
    name: "lodash",
    "dist-tags": { latest: "4.17.21" },
    version: "4.17.21",
  });
});

test("an existing top-level version is preserved", async () => {
  // source: Version normalization must use the dist-tag only when the top-level version is nullish.
  mockFetch({
    "https://registry.npmjs.org/lodash": {
      body: { name: "lodash", version: "4.17.20", "dist-tags": { latest: "4.17.21" }, description: "Preserved" },
    },
  });

  expect(await fetchPackageData("lodash")).toEqual({
    name: "lodash",
    version: "4.17.20",
    "dist-tags": { latest: "4.17.21" },
    description: "Preserved",
  });
});

test("check_security includes the latest version in its result and recommendation", async () => {
  // source: Missing registry versions prevented the Latest version note from showing the release.
  mockFetch({
    ...registryFixtures("lodash", "4.17.21"),
    [`${lodashUrl}%404.17.20`]: { body: [] },
  });

  const result = await checkSecurity("lodash", "4.17.20");
  expect(result.latestVersion).toBe("4.17.21");
  expect(result.recommendation).toBe('No known security advisories for "lodash" 4.17.20. Latest version: 4.17.21');
});

test("dependency analysis filters advisories by valid dependency versions", async () => {
  // source: review, dependency analysis counted advisories for every version of a package
  const otherUrl = "https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=other";
  const fetchMock = mockFetch({
    ...registryFixtures("lodash", "4.17.21"),
    ...registryFixtures("other", "1.0.0"),
    [`${lodashUrl}%404.17.20`]: { body: [] },
    [otherUrl]: { body: [] },
  });

  await analyzePackageJson({ dependencies: { lodash: "4.17.20", other: "latest" } });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  const lodashRequest = urls.find((url) => url.startsWith(lodashUrl));
  const otherRequest = urls.find((url) => url.startsWith(otherUrl));
  expect(lodashRequest).toContain("affects=lodash%404.17.20");
  expect(otherRequest).toContain("affects=other");
  expect(otherRequest).not.toContain("%40");
});

test("dependency analysis detects patch and major updates from dist-tags", async () => {
  // source: Missing latest versions made every dependency appear up to date.
  mockFetch({
    ...registryFixtures("lodash", "4.17.21"),
    ...registryFixtures("zod", "4.1.0"),
    [`${lodashUrl}%404.17.20`]: { body: [] },
    [`${zodUrl}%403.0.0`]: { body: [] },
  });

  const result = await analyzePackageJson({ dependencies: { lodash: "4.17.20", zod: "^3.0.0" } });
  expect(result.dependencies).toMatchObject([
    { name: "lodash", current: "4.17.20", latest: "4.17.21", status: "patch", securityIssues: 0 },
    { name: "zod", current: "3.0.0", latest: "4.1.0", status: "major", securityIssues: 0 },
  ]);
  expect(result.outdatedCount).toBe(2);
  expect(result.summary).toBe("Analyzed 2 dependencies. 2 packages have updates available.");
});

test("dependency analysis records and counts failed security lookups", async () => {
  // source: Security lookup failures must remain visible for dependencies and missing development packages.
  mockFetch({
    ...registryFixtures("lodash", "4.17.21"),
    ...registryFixtures("zod", "4.1.0"),
    ...registryFixtures("missing", "1.0.0"),
    "https://registry.npmjs.org/missing": { status: 404, body: {} },
    [`${lodashUrl}%404.17.20`]: { status: 403, body: {} },
    [`${zodUrl}%403.0.0`]: { body: [] },
    "https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=missing%401.0.0": { status: 403, body: {} },
  });

  const result = await analyzePackageJson({
    dependencies: { lodash: "4.17.20", zod: "^3.0.0" },
    devDependencies: { missing: "1.0.0" },
  });
  expect(result.dependencies[0]).toMatchObject({
    status: "patch", latest: "4.17.21", securityIssues: 0,
    securityError: "GitHub advisory lookup failed for lodash: HTTP 403",
  });
  expect(result.dependencies[1].securityError).toBeUndefined();
  expect(result.devDependencies?.[0]).toMatchObject({
    status: "unknown", securityIssues: 0,
    securityError: "GitHub advisory lookup failed for missing: HTTP 403",
  });
  expect(result.securityIssueCount).toBe(0);
  expect(result.summary).toBe("Analyzed 3 dependencies. 2 packages have updates available. Security lookup failed for 2 package(s).");
});

test("research uses the latest dist-tag for version and publish information", async () => {
  // source: Missing registry versions suppressed versionsBehind and the latest publish timestamp.
  mockFetch({ ...researchFixtures(), [`${zodUrl}%403.0.0`]: { body: [] } });

  const result = await researchPackage("zod", "3.0.0");
  expect(result.latestVersion).toBe("4.0.0");
  expect(result.versionsBehind).toBe(2);
  expect(result.maintenance.lastPublish).toBe("2025-01-01T00:00:00Z");
  expect(result.security.error).toBeUndefined();
});

test("research still returns with an explicit advisory lookup error", async () => {
  // source: Research must expose failed security lookups while retaining available package information.
  mockFetch({ ...researchFixtures(), [`${zodUrl}%403.0.0`]: { status: 403, body: {} } });

  const result = await researchPackage("zod", "3.0.0");
  expect(result.latestVersion).toBe("4.0.0");
  expect(result.versionsBehind).toBe(2);
  expect(result.maintenance.lastPublish).toBe("2025-01-01T00:00:00Z");
  expect(result.security).toEqual({
    advisoryCount: 0, criticalCount: 0, highCount: 0, advisories: [],
    error: "GitHub advisory lookup failed for zod: HTTP 403",
  });
});
