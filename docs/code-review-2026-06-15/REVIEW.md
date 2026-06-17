# Code Review — ecosystem-mcp (Tier 2)

**Date:** 2026-06-16
**Method:** 9-dimension review (correctness, error handling, types/validation, performance, security, testing, maintainability, API contracts, resilience).

> **Note:** Findings were surfaced by review; critical/high are adversarially verified in the Verification section below. Medium/low findings are reported as raised and have **not** yet been adversarially verified. Treat severities as provisional until verification confirms reproducibility.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 24 |
| Medium   | 30 |
| Low      | 12 |
| **Total**| **66** |

Findings cluster around a handful of root causes: (1) `zod` imported but never used — **no runtime validation anywhere**, so all MCP args and all external API responses are `as`-cast blind; (2) the security version-filter is a non-functional stub; (3) no timeouts / retries / `Promise.allSettled` on a fan-out tool that issues 90+ serial+parallel calls; (4) zero test coverage. Fixing #1 and #2 plus adding timeouts/retry knocks out the majority of the high-severity list.

---

## Critical

_No critical findings._

---

## High

**Version filtering in security-client is non-functional** — `src/tools/security-client.ts:64-72`
The version filter checks `a.vulnerableVersions` exists then returns `true` unconditionally ("Return all for now" / "production would use proper semver matching"). The `version` parameter is accepted but ignored, so version-specific security checks silently return all advisories for the package. This is a functional bug masked as a TODO and produces false positives.
**Fix:** Implement semver range matching with the already-available `semver` lib — `semver.satisfies(version, a.vulnerableVersions)` (or `semver.intersects` for range-vs-range). Test: range `1.0.0–2.0.0` with query `1.5.0` (match), `3.0.0` (no match), and a pre-release edge case.

**Missing null/undefined checks for API response data in compare-packages** — `src/tools/compare-packages.ts:69-74, 91-92`
`downloads?.downloads` (69) and `githubData?.stargazers_count` (70) assign `undefined` on incomplete responses. `sorted[0]` is taken as `topPick` after only a `validResults.length > 0` guard — but if every package failed, `validResults` is empty, the guard passes the wrong way, and `topPick.name` / `topPick.weeklyDownloads?.toLocaleString()` (92) crash on `undefined`.
**Fix:** Guard `if (sorted.length > 0) { const topPick = sorted[0]; ... }`. Provide `'N/A'`/`'0'` fallbacks for missing downloads/stars in the recommendation string.

**Missing input validation on package names and user inputs** — `src/index.ts:333-352`
Package names, versions, and categories flow straight to API calls. `zod` is imported (line 24) but never instantiated. Inputs are `as string` / `as Record<string, unknown>` cast with no checks.
**Fix:** Per-tool zod schemas validated before processing, e.g. `const pkg = z.string().min(1).max(256).parse(args?.package)`.

**Unsafe type assertion on untrusted GitHub advisory response** — `src/tools/security-client.ts:44-58`
`const data = await response.json()` is `any`; the code then `for (const advisory of data)` and reads `advisory.ghsa_id`, `advisory.severity`, `advisory.vulnerabilities[0]` with no runtime validation. Schema drift or a non-array body causes undefined/null deref.
**Fix:** Validate with `z.array(advisorySchema).safeParse(data)`; on failure return the empty advisories list. Also guard `if (!Array.isArray(data)) return advisories;`.

**Unsafe type assertions of MCP request arguments without validation** — `src/index.ts:334-398`
`args?.package as string`, `args?.packages as string[]`, `args?.packageJson as Record<string, unknown>` assume the caller sends correct types. A wrong-typed or missing arg passes compile-time but fails at runtime deep in the client layer (e.g. `researchPackage(null)` crashes inside npm-client).
**Fix:** Validate args with a per-tool zod schema at the `CallToolRequest` entry point; return `{ isError: true }` with the zod error message instead of letting cryptic downstream failures surface.

**Unsafe type assertion of npm/GitHub API responses without validation** — `src/tools/github-client.ts:63`, `src/tools/npm-client.ts:39,55`
`return await response.json()` is implicitly cast to `GitHubRepo` / npm metadata interfaces with no validation. Breaking API changes pass typechecking and fail at property-access time.
**Fix:** Validate with zod schemas (`githubRepoSchema.parse(data)`) before returning.

**Unsafe cast of packageJson.dependencies without validation** — `src/tools/analyze-package-json.ts:95-98`
`(packageJson.dependencies || {}) as Record<string, string>` does not verify values are strings. A malformed `package.json` (array/object/number dep values) passes the cast and breaks `analyzeDependency` downstream.
**Fix:** `const deps = z.record(z.string()).parse(packageJson.dependencies || {})`.

**N+1 GitHub/npm API calls in analyzePackageJson** — `src/tools/analyze-package-json.ts:106-109`
`analyzePackageJson` → `analyzeDependency` per dependency, each issuing `fetchPackageData` + `fetchDownloads` + `checkSecurityAdvisories`. 20 deps + 10 devDeps ⇒ ~90 calls. Unauthenticated GitHub allows only 60 req/hr, so analysis routinely rate-limits.
**Fix:** Batch/dedup the advisory lookups, or throttle to small parallel groups (e.g. `p-limit(5)`). Cache responses for popular packages.

**Sequential GitHub fetch inside Promise.all in comparePackages** — `src/tools/compare-packages.ts:54-55`
Within the `Promise.all` map (line 34), each package awaits `fetchRepoFromNpmUrl` only **after** npm + downloads resolve — a per-package waterfall (npm → downloads → GitHub). For 5 packages that's ~250ms × 5 of avoidable serial latency on the critical path.
**Fix:** Kick off the GitHub fetch in parallel: `Promise.all([npm, downloads, github])` rather than awaiting npm+downloads first.

**Unbounded O(n log n) version sort in research-package** — `src/tools/research-package.ts:72-79`
For packages like Webpack (600+ versions) the code `Object.keys(npmData.versions)`, filters with `semver.valid`, sorts all with `semver.rcompare`, then `findIndex`. All that work to compare current vs latest.
**Fix:** Read `npmData['dist-tags'].latest` directly; compute `currentIndex` against latest only, no full-history sort.

**Redundant linear search building topPriorities** — `src/tools/analyze-package-json.ts:130`
`topPriorities.some(p => p.includes(dep.name))` per major-update dep is O(n·m) and uses substring `includes` for what should be exact-name matching. Fine at current limits, but the pattern is wrong.
**Fix:** Track added names in a `Set` for O(1) exact lookup.

**Unhandled JSON parse failures on npm responses** — `src/tools/npm-client.ts:39`
`response.json()` can throw `SyntaxError` (HTML error page, malformed body). It's only caught by the outer try/catch, which returns `null` silently, masking the real failure mode.
**Fix:** Wrap `response.json()` in its own try/catch and surface a distinct "Invalid JSON from npm registry" error.

**No retry logic for transient API failures** — `src/tools/npm-client.ts:33-43`
No retry on timeouts / 429 / 503. One transient blip fails the tool, especially painful for `analyze_package_json`'s 20-30 serial requests.
**Fix:** Exponential backoff (2-3 attempts, 100ms-1s) on retryable codes (408, 429, 5xx); fail fast on permanent (404, 401).

**Missing timeout on npm registry fetches** — `src/tools/npm-client.ts:34,51-52`
No `AbortSignal.timeout()`. A hung npm request blocks indefinitely; with 30+ parallel calls in `analyze_package_json`, one hang stalls the whole analysis and times out the MCP call.
**Fix:** Add `signal: AbortSignal.timeout(10_000)` to both `fetchPackageData` and `fetchDownloads`.

**Uncaught JSON parse errors in security advisory API** — `src/tools/security-client.ts:45`
`response.json()` isn't wrapped; an HTML error page from GitHub throws into the outer catch (line 60), which logs and returns empty advisories — a **false-negative security result**.
**Fix:** try/catch the parse before the loop; on failure log and return current advisories. Also `Array.isArray` guard.

**Unvalidated type casting in tool request handler** — `src/index.ts:334,340,345,352,359`
`as string` / `as string[]` with no validation. `researchPackage(null)` crashes inside npm-client with "null is not a string".
**Fix:** zod-parse args before assertion; use `parsed.package` not `args?.package as string`.

**Promise.all failure cascades in parallel dependency analysis** — `src/tools/analyze-package-json.ts:106-108`
One failed dependency fetch rejects the entire `Promise.all`, failing the whole analysis instead of skipping the bad dep. Critical for rate-limited users.
**Fix:** `Promise.allSettled`, then map fulfilled→value / rejected→null and filter. Mark failed deps with a status field so callers can decide.

**Missing null check before array access in recommendations** — `src/tools/compare-packages.ts:91`
`sorted[0]` is reached after a `validResults.length > 0` check, but if all packages fail, `validResults` is empty, the check passes, and `topPick`/`topPick.name` (92) deref `undefined`. (Same root cause as the compare-packages null-check finding above.)
**Fix:** `if (sorted.length > 0) { const topPick = sorted[0]; ... }`.

**No test suite — zero coverage on critical paths** — `src/` (project root)
No `.test.ts`/`.spec.ts` files and no test runner in `package.json`. Zero coverage for npm/GitHub integration, advisory checking, semver logic, and every error path.
**Fix:** Add vitest/jest. Cover: npm-client fetch errors (404/500/timeout), GitHub failures + rate limiting, semver calc in research-package, advisory parse + severity filter, version-diff detection, dependency analysis with invalid versions.

**Unchecked null deref in version comparison logic** — `src/tools/research-package.ts:71-80`
`versionsBehind` assumes `npmData.versions` and `npmData.version` exist and are valid semver. Missing/undefined `versions` throws on `Object.keys`; invalid current version throws in `semver.eq()` (line 76).
**Fix:** Guard `npmData.versions` before `Object.keys`; handle `semver.valid() === null`; wrap `semver.eq` in try/catch; test pre-release + invalid registry versions.

**Silent failures in external API calls hide real errors** — `src/tools/npm-client.ts:33-44` (also github-client, security-client)
Every fetch catches all and returns `null` with only `console.error`. Callers cannot distinguish 404 vs 429 vs timeout vs malformed body. `research-package.ts:61-62` only throws on null npm data, collapsing distinct failures into one. This masking cascades into research/compare/find-alternatives/analyze/trending.
**Fix:** Typed error classes (`PackageNotFound`, `RateLimited`, `NetworkError`) or a `Result<T,E>` return so callers can retry transient and fail-fast permanent. Tests for 404/429/500/timeout/malformed.

**No validation of advisory data structure before nested-field access** — `src/tools/security-client.ts:44-58`
Inconsistent optional chaining: `advisory.severity?.toLowerCase()` (49), `advisory.vulnerabilities?.[0]?.patched_versions` (53). Schema drift admits invalid advisories with missing required fields into the result list.
**Fix:** zod schema for the advisory shape; validate parsed JSON; filter out invalid entries. Test missing severity, empty vulnerabilities, renamed fields.

**Duplicated TypeScript-detection logic across files** — `src/tools/research-package.ts:97-102` (also compare-packages)
The "has TypeScript support" heuristic (keyword `typescript`/`types`, `@types/` prefix) is copy-pasted in two tools — DRY violation and double maintenance.
**Fix:** Extract `hasTypeScriptSupport(npmData): boolean` into a shared util (e.g. npm-client).

**Unused parameter in findAlternatives** — `src/tools/find-alternatives.ts:156-159`
`_category` is declared and exposed via the MCP tool definition but never used; the function relies entirely on the hardcoded `ALTERNATIVES_MAP`.
**Fix:** Implement category filtering, or remove the param from the signature and the tool schema.

**Zod imported but never used; tool schemas not validated** — `src/index.ts:24`
`import { z } from 'zod'` is dead. All 8 tool schemas are plain JS objects with no runtime validation, contradicting the AGENTS.md rule "Keep tool schemas stable and Zod-validated." This is the root cause behind most of the high-severity validation findings.
**Fix:** Wrap tool schemas with `z.object()` and validate args at call time — or remove the import if validation is intentionally deferred (it should not be).

---

## Medium

**Unsafe `as keyof typeof SCHEMAS` for preset without membership check** — `src/index.ts:364-378` (also 366, 383)
`args?.preset as keyof typeof SCHEMAS` doesn't verify the preset exists; an invalid string yields `undefined`, silently passed to `deepSearch()`, surfacing as a confusing downstream schema error.
**Fix:** `const presetSchema = z.enum(Object.keys(SCHEMAS) as [string, ...string[]]); const r = presetSchema.safeParse(args.preset);` use `r.success ? SCHEMAS[r.data] : fallback`.

**Incomplete error handling in analyzeDependency** — `src/tools/analyze-package-json.ts:58-59`
`semver.valid()` returns null for malformed versions but the result isn't checked; an invalid `currentVersion` (after the regex strip on line 42) or malformed `npmData.version` makes the comparison silently fall through to status `up-to-date`, misleading the user.
**Fix:** Validate both versions; if either is invalid set status `unknown` with a clear "version format unrecognizable" recommendation.

**Missing validation for GitHub URL parsing** — `src/tools/github-client.ts:29-35`
If the regex matches but a capture group is empty/odd, the destructured `owner`/`repo` (34) are passed to `fetchRepo()` unvalidated.
**Fix:** After match, assert both are non-empty and contain only `[A-Za-z0-9._-]`; return null early otherwise.

**No timeout protection on npm fetch operations** — `src/tools/npm-client.ts:30-44, 46-60`
(Overlaps the high-severity timeout finding.) Add `signal: AbortSignal.timeout(5000)` (5-10s) to both fetches; make the timeout configurable.

**Unsafe GitHub URL interpolation without encoding** — `src/tools/github-client.ts:23-36`
`${GITHUB_API}/repos/${owner}/${repo}` (line 54) interpolates extracted path params without URL-encoding. The regex limits chars, but encoding is correct defense-in-depth.
**Fix:** `encodeURIComponent(owner)` / `encodeURIComponent(repo)`.

**API error response text included in exceptions without sanitization** — `src/tools/exa-deep.ts:141-144, 166-169, 181-183`
`const err = await response.text(); throw new Error(...)` embeds raw upstream error bodies, which could carry sensitive data into logs.
**Fix:** Truncate/redact: `const safeErr = err.length > 200 ? err.slice(0,200)+'...' : err`.

**Unvalidated nullable property chain in research-package** — `src/tools/research-package.ts:66-67`
`npmData.repository?.url` then `fetchRepoFromNpmUrl(repoUrl)`. `repository` may be an object without `url`; optional chaining hides that `repository`'s shape is never validated against `NpmPackageData`.
**Fix:** zod-validate `npmData` shape (`repository: z.object({ url: z.string() }).optional()`).

**Unvalidated Exa API response casts** — `src/tools/exa-deep.ts:146,171,185`
`as ExaDeepResponse` (146), `as { researchId: string }` (171), and similar casts have no runtime validation; Exa schema changes silently propagate `undefined` (e.g. `data.researchId`) downstream.
**Fix:** zod schemas + `.parse()` for each Exa response shape (`researchId`, `output.grounding`, etc.).

**No retry/backoff for flaky npm registry calls** — `src/tools/npm-client.ts:30-60`
(Overlaps high-severity retry finding.) Differentiate transient (5xx/timeout) from permanent (404); retry transient up to 3× with backoff; detect rate-limit headers.

**Inefficient framework filtering in getTrending** — `src/tools/get-trending.ts:113-121`
`prefixes.some(p => pkg.toLowerCase().includes(p))` per package is O(p·k) and re-lowercases repeatedly; the `length < 3 → revert` fallback signals the heuristic is unreliable.
**Fix:** Precompute lowercase names/prefixes once; prefer the curated `CATEGORY_PACKAGES` over fragile dynamic filtering.

**No timeout / partial-data handling in findAlternatives GitHub fetches** — `src/tools/find-alternatives.ts:172-196`
Up to 4 parallel `fetchRepoFromNpmUrl`; any failure drops the alternative silently (null filter, 198). One GitHub timeout breaks results.
**Fix:** 2s per-call timeout with graceful degradation (return alt without stars on timeout); cache GitHub data across calls.

**Untested semver ops with invalid input** — `src/tools/research-package.ts:71-80`
`semver.eq()` / `semver.rcompare()` are unguarded; an invalid old version throws and fails the whole research.
**Fix:** Pre-filter `versions.filter(v => semver.valid(v) !== null)`; wrap comparisons in try/catch.

**GitHub JSON parse vs network error conflation** — `src/tools/github-client.ts:63-66`
`response.json()` (63) `SyntaxError` is caught by the same catch (64) that returns null for network errors, masking which failure occurred.
**Fix:** Separate try/catch around the parse with a distinct log.

**Exa research polling lacks per-poll timeout** — `src/tools/exa-deep.ts:199-205`
`pollResearchTask()` has a deadline loop but `getResearchTask()` fetch (176) has no `AbortSignal.timeout`; a hung poll ties the loop up to the `maxWait` deadline (~3 min).
**Fix:** `signal: AbortSignal.timeout(30_000)` on the poll fetch.

**Unvalidated array iteration in advisory parsing** — `src/tools/security-client.ts:46`
`for (const advisory of data)` assumes `data` is an array; an object/null silently iterates nothing.
**Fix:** `if (!Array.isArray(data)) { console.warn(...); return advisories; }`.

**No backpressure / concurrency cap on dependency analysis** — `src/tools/analyze-package-json.ts:100-109`
Hardcoded limits (20 deps / 10 devDeps) but no throttling; 20 parallel deps × 3 calls each can 429 the registry. (Overlaps the N+1 and rate-limit findings.)
**Fix:** `p-limit(5)` or a semaphore around the `Promise.all` map; exponential backoff on 429/503; short-lived response cache.

**Swallowed/misleading errors in exa-deep search** — `src/tools/exa-deep.ts:137,141-143,166-168,180-182`
If `response.text()` itself fails (consumed/empty body) the error message is misleading; `JSON.stringify(body)` (137) can throw on circular refs and isn't wrapped.
**Fix:** Guard `response.text()` with a `Status ${status}` fallback; wrap `JSON.stringify` in try/catch.

**Inconsistent error representation across tool outputs** — `src/tools/security-client.ts:64-72`
(Same stub as the high-severity version-filter finding; reported separately for the "security checks pass unvalidated upstream" angle.) Implement real semver matching and document the filtering contract.

**Layering violation: domain data embedded in tool logic** — `src/tools/find-alternatives.ts:10-59, 109-154` (also get-trending CATEGORY_PACKAGES)
`ALTERNATIVES_MAP`, `getProsAndCons()`, `getMigrationEffort()` mix API-client calls, hardcoded domain knowledge, and synthesis in one file — tight coupling, hard to test/reuse.
**Fix:** Extract data to `alternatives-data.ts`; keep the tool as thin orchestration.

**Unchecked property access on advisory objects with chained fallbacks** — `src/tools/security-client.ts:48-54`
`advisory.ghsa_id || advisory.id`, `advisory.summary || advisory.title` — if all fallbacks are undefined the field is silently undefined; no required-field validation.
**Fix:** zod-validate advisories; error/skip when `id`/`severity`/`title` are all missing.

**No npm response shape validation** — `src/tools/npm-client.ts:39`
(Overlaps high-severity npm-cast finding.) Define and validate an npm-metadata zod schema before returning.

**Unsafe iteration over possibly-undefined versions** — `src/tools/research-package.ts:71-79`
`Object.keys(npmData.versions)` throws if `versions` is null/undefined.
**Fix:** `const versions = npmData.versions ? Object.keys(npmData.versions) : [];`.

**No throttling / request coalescing across parallel tool calls** — `src/tools/analyze-package-json.ts:100-109`
`Promise.all` of `analyzeDependency`, each spawning 3 parallel calls, can emit hundreds of concurrent requests with no dedup/batch/backoff. Compounds across concurrent tool calls.
**Fix:** Module-level pool (max ~6 concurrent per host), dedup same-URL requests in a short window, backoff on 429/503, 1-5 min response cache.

**Type-unsafe argument coercion in CallToolRequestSchema handler** — `src/index.ts:325-432`
(Overlaps the high-severity arg-validation findings.) Per-tool zod validation at the handler boundary, e.g. `z.object({ packages: z.array(z.string().min(1)).min(2).max(5) }).parse(args)`; return a clear MCP error on failure.

**No handling of malformed/SSH GitHub repository URLs** — `src/tools/github-client.ts:28-35`
The regex misses `git@github.com:owner/repo.git`, trailing-slash, and some `git+https` forms, silently returning null and dropping valid repo data.
**Fix:** Support SSH form; test against `https://…/owner/repo`, `git+https://…/owner/repo.git`, `git@github.com:owner/repo.git`, trailing-slash, `.git`.

**No edge-case handling in trending calculation** — `src/tools/get-trending.ts:141-149`
`monthlyDownloads / 4` produces `Infinity`/`NaN` when monthly is 0/null; null weekly silently mis-compares.
**Fix:** Guard both values exist; mark `unknown` trend otherwise. Test zero/null/tiny/spike.

**Incomplete validation of the alternatives mapping** — `src/tools/find-alternatives.ts:109-154`
No validation that every `ALTERNATIVES_MAP` package has a `getProsAndCons` entry, that pros/cons arrays match, or that migration estimates are consistent; new alternatives fall back to generic text.
**Fix:** Startup validation that all mapped packages have pros/cons entries; zod-enforce array structure (min 2 items).

**Preset schema enum duplicated across tool definitions** — `src/index.ts:192-201, 243-252`
Preset names (`companyProfile`, `preCallBriefing`, …) are hardcoded in two enum arrays (exa_deep_search and exa_research).
**Fix:** A single `PRESET_NAMES` constant in exa-deep.ts referenced by both definitions.

**Magic numbers for slice limits scattered across files** — `src/tools/analyze-package-json.ts:101, 103, 123, 129`
Hardcoded `20/10/3/2/8/4/5` slice limits across tools.
**Fix:** A `LIMITS` config object (`{ maxDependencies: 20, maxDevDependencies: 10, ... }`).

**ALTERNATIVES_MAP not scalable / redundant bidirectional entries** — `src/tools/find-alternatives.ts:10-59`
50-line nested map with manually-synced asymmetric mappings (moment↔dayjs).
**Fix:** Unidirectional map + programmatically built reverse, or a structured data format.

**Pros/cons data hardcoded inside getProsAndCons** — `src/tools/find-alternatives.ts:109-154`
Only 10 packages have data; the rest get generic defaults; business data coupled to function logic.
**Fix:** Extract to a module-level constant or data file.

**Inconsistent null-on-failure pattern across fetches** — `src/tools/npm-client.ts:30-60`
(Overlaps the silent-failure high finding.) Adopt a `Result<T>` / consistent error-object pattern instead of bare null.

**Repeated GitHub repo-URL parsing logic in the wrong place** — `src/tools/github-client.ts:23-36`
The npm-repo-field regex lives inline in one helper; not reusable/testable.
**Fix:** Extract a dedicated, documented, testable function.

---

## Low

**TypeScript detection heuristic is incomplete** — `src/tools/research-package.ts:96-102`
Only checks keywords + `@types/` prefix; misses packages with a `types`/`typings` field, yielding false `typescript: false`.
**Fix:** Also check `npmData.types || npmData.typings`.

**Potential TypeError on missing monthly downloads in getTrending** — `src/tools/get-trending.ts:127-159`
Line 143 assumes `monthlyDownloads` exists; if the monthly fetch returns null, `/4` throws.
**Fix:** `if (monthlyDownloads?.downloads) { ... } else default to 'stable'`.

**Information disclosure via console.error logging** — `src/tools/npm-client.ts:41`, `github-client.ts:65`, `security-client.ts:61`
Full error objects + package names + URLs logged at error level; may leak behavior in production.
**Fix:** Generic messages or `console.debug` for non-critical failures; use a level-aware logger.

**Unused zod import** — `src/index.ts:24`
(Same root cause as the high-severity dead-zod finding; listed at low for the pure cleanup angle.) Remove or implement.

**Inefficient duplicate filtering for topPriorities** — `src/tools/analyze-package-json.ts:120-133`
O(n)-per-iteration `string.includes()` dedup across `withSecurity` + `majorUpdates`.
**Fix:** Single pass with a `Set` of names, sorted by priority score.

**Missing timeout on createResearchTask** — `src/tools/exa-deep.ts:157`
`deepSearch()` has `AbortSignal.timeout(60_000)` but `createResearchTask()` has none; a hung accept hangs the promise.
**Fix:** `signal: AbortSignal.timeout(30_000)`.

**Missing test coverage for TypeScript-detection heuristics** — `src/tools/research-package.ts:97-102`
No tests for the heuristic's false-positive/negative cases.
**Fix:** Tests for `@types/react` (true), keyword-only (true), typed-no-keyword (false), `@not-types/pkg` (false).

**Default client singleton with mutable module state** — `src/tools/exa-deep.ts:604-611`
Module-level `_defaultClient` is a hidden lazy singleton — hard to test, couples convenience fns to global state.
**Fix:** Inject `ExaDeepClient` explicitly or use DI.

**Large preset SCHEMAS block in one file** — `src/tools/exa-deep.ts:240-598`
359 lines of JSON-schema defs mixed with client logic.
**Fix:** Extract to `schemas.ts`.

**Loose type casting for MCP tool arguments** — `src/index.ts:334-360`
(Overlaps high-severity arg-cast findings; low here for the cleanup framing.) Use zod before casting.

**Inconsistent null handling in compare-packages comparison data** — `src/tools/compare-packages.ts:40-51`
Not-found packages return a zeros placeholder; mixed found/not-found results can be misread.
**Fix:** Either throw on not-found, or return `{ name, found: false, error: 'Not found' }`.

**Inconsistent error contract: throw vs graceful result** — `src/tools/research-package.ts:61-63`
`researchPackage` throws on not-found while `comparePackages` returns a `NOT FOUND` status — unpredictable for callers.
**Fix:** Standardize on a unified error result type or a consistent `PackageNotFoundError` class; document the contract.

---

## Verification (to be completed)

> The high-severity findings above are the verification targets. Reproduce each before treating it as confirmed:
> 1. **Security version-filter stub** (`security-client.ts:64-72`) — call with a version known to be outside an advisory's range; confirm it still returns the advisory.
> 2. **compare-packages all-fail crash** (`compare-packages.ts:91-92`) — invoke with package names that all 404; confirm `topPick.name` throws.
> 3. **Promise.all cascade** (`analyze-package-json.ts:106-108`) — make one dep 404 mid-batch; confirm the whole analysis rejects.
> 4. **No timeout / hang** (`npm-client.ts:34`) — point at a hanging endpoint; confirm indefinite block.
> 5. **Dead zod / no validation** (`index.ts:24, 333-398`) — confirm `z` has no references and args reach clients unvalidated (`grep -n '\bz\.' src/index.ts`).
> 6. **N+1 / rate limit** (`analyze-package-json.ts:106-109`) — count outbound requests for a 30-dep package.json.

Until each is reproduced, treat the corresponding severity as provisional.

---

## Adversarial verification (critical/high)

Each critical/high finding was independently re-checked against the source. Verdicts:

1. **Version filtering in security-client is non-functional** — CONFIRMED-REAL: `security-client.ts:65-71` unconditionally returns all advisories ("Return all for now, let caller filter"), so the `version` param is ignored and callers get unfiltered results.
2. **Missing null/undefined checks for API response data in compare-packages @ src/tools/compare-packages.ts:69-74** — REFUTED: optional chaining already guards lines 69-70/92, and the `if (validResults.length > 0)` check at line 83 guarantees `sorted` is non-empty.
3. **Missing Input Validation on Package Names and User Inputs** — REFUTED: inputs are `encodeURIComponent`-encoded before URL use, never reach shell/db/eval, and tools whitelist against known maps; the unused Zod import is a code-quality issue, not a vuln.
4. **Unsafe type assertion on untrusted API response data in security-client.ts** — CONFIRMED-REAL: line 45 returns `any` from `response.json()` and line 46 iterates without an `Array.isArray` guard, producing advisories with undefined required `id` if the API/proxy returns a non-array.
5. **Unsafe type assertions of request arguments without validation in index.ts** — CONFIRMED-REAL: handler casts MCP args with `as` (lines 334-398) with zero runtime checks; Zod is imported but never invoked, so malformed types fail at runtime instead of validation time.
6. **Unsafe type assertion of API response data without validation in npm-client.ts and github-client.ts** — REFUTED: strict-mode TypeScript enforces declared return types (`Promise<...|null>`), `--noEmit` passes, and all callers use null checks/optional chaining; runtime-validation is a robustness nice-to-have, not a type-safety bug.
7. **Unsafe type assertion of packageJson.dependencies without validation** — CONFIRMED-REAL: `analyze-package-json.ts:95-98` casts deps to `Record<string,string>` unchecked; a non-string value reaches `versionSpec.replace(...)` (line 42) and throws TypeError on adversarial/corrupt package.json.
8. **N+1 GitHub API calls in analyzePackageJson** — CONFIRMED-REAL: one `/advisories` call per dependency (30 deps = 30 calls = 50% of the 60/hr unauthenticated quota); real bottleneck, mitigated by `GITHUB_TOKEN` (5,000/hr). The original "90 calls" figure overcounts.
9. **Sequential GitHub fetch within Promise.all in comparePackages** — CONFIRMED-REAL: the GitHub fetch (line 55) is awaited after the inner `Promise.all` (line 35) inside each callback, serializing one GitHub round-trip per package onto the critical path (~250ms × N).
10. **Unbounded version sorting with O(n log n) in research-package for large version histories** — REFUTED: measured ~25-29ms for React/TypeScript histories, runs once per invocation behind 200-500ms network calls, and the sort is necessary (npm metadata is chronological, not semver-ordered).
11. **Redundant linear search in analyzePackageJson topPriorities** — CONFIRMED-REAL: the complexity claim is moot, but line 130 dedupes with `p.includes(dep.name)` (substring match), which is semantically wrong for package-name dedup and silently mis-dedups on substring collisions.
12. **Unhandled JSON parsing failures on API responses** — REFUTED: `response.json()` (line 39) is inside a try-catch (lines 33-43) that logs and returns null; all callers handle the null return correctly.
13. **No retry logic for transient API failures in ecosystem-mcp npm-client.ts** — CONFIRMED-REAL: `fetchPackageData`/`fetchDownloads` (lines 30-60) make single fetches with no retry; a transient blip silently fails the whole multi-call analysis. Affects all 6 tools.
14. **Missing timeout on npm registry fetch requests** — CONFIRMED-REAL: bare `fetch()` calls (npm-client lines 34/51-52, security-client line 39) have no `AbortSignal.timeout`; analyze spawns ~90 parallel un-timed fetches, so one hung request blocks the whole tool.
15. **Uncaught JSON parse errors in security advisory API** — CONFIRMED-REAL: `response.json()` (line 45) is inside the `response.ok` guard but not its own try-catch; malformed 200-body JSON falls to the outer catch (line 60), returns `[]`, and all three callers read that as "no vulnerabilities" — a silent false-negative.
16. **Unvalidated type casting in tool request handler @ ecosystem-mcp/src/index.ts** — CONFIRMED-REAL: `as` assertions on unvalidated MCP args (e.g. `args?.packages as string[]`) let `{"packages": null}` reach `packages.length` and throw; caught by try-catch so it returns an error response, but callers can still trigger handler malfunction.
17. **Promise.all() failure cascades in parallel requests** — REFUTED: `analyzeDependency` and all three helpers never reject (they return null/`[]`/`status:"unknown"`), so the `Promise.all` (lines 106-108) always resolves; failures degrade, they do not cascade.
18. **Missing null check before array access in recommendations @ compare-packages.ts:91** — REFUTED: `if (validResults.length > 0)` is false on an empty array, so the block (lines 84-92) is skipped and `sorted[0]` is never reached.
19. **No test suite exists - zero test coverage on critical paths** — CONFIRMED-REAL: no test files, no test script/framework in package.json, no test config; 6 production tools with version/regex/security logic are entirely untested.
20. **Unchecked null dereference in version comparison logic @ research-package.ts:71-80** — CONFIRMED-REAL: `currentVersion` is passed to `semver.eq()` (line 76) without `semver.valid()` validation, so an invalid version string throws an internal SemVer TypeError (caught upstream, but poor UX with no defensive validation).
21. **Silent failures in external API calls with graceful degradation hiding real errors** — CONFIRMED-REAL: `fetchPackageData`/`fetchDownloads` collapse all non-404 errors (429/5xx/timeout) to null with only console.error; callers can't distinguish "not found" from "rate-limited/unavailable", blocking backoff/retry strategies.
22. **No validation of advisory data structure before accessing nested fields** — CONFIRMED-REAL: `security-client.ts:44-58` parses the advisories response with no schema validation; out-of-union `severity` values pass the `toLowerCase()` fallback and then silently fail exact-match filters downstream, dropping/miscategorizing advisories.
23. **Version filtering in security check is non-functional** — CONFIRMED-REAL: the filter at lines 67-71 returns `true` unconditionally (line 70), ignoring `vulnerableVersions`/`version` ("production would use proper semver matching"); callers get version-irrelevant advisories (false positives).
24. **Duplicated TypeScript detection logic across multiple files** — CONFIRMED-REAL: identical TS-detection code in `research-package.ts:97-102` and `compare-packages.ts:58-63`; no shared util, so future changes must be applied in two places.
25. **Unused parameter in findAlternatives function** — CONFIRMED-REAL: `_category` is accepted by the schema (index.ts:107-110) and passed through (line 346) but never used in the implementation; the hint has zero effect on results.

**Tally: 18 confirmed / 7 refuted** (of 25 findings).
