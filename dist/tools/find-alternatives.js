/**
 * Find Alternatives Tool
 *
 * Find alternative packages to a given package.
 */
import { fetchDownloads, fetchPackageData, NpmLookupError, repositoryUrl } from "./npm-client.js";
import { fetchRepoFromNpmUrl } from "./github-client.js";
const ALTERNATIVES_MAP = {
    moment: ["date-fns", "dayjs", "luxon"],
    "date-fns": ["dayjs", "luxon", "moment"],
    dayjs: ["date-fns", "luxon", "moment"],
    axios: ["ky", "got", "node-fetch", "undici"],
    "node-fetch": ["undici", "axios", "ky", "got"],
    got: ["axios", "ky", "undici"],
    request: ["axios", "got", "node-fetch"],
    redux: ["zustand", "jotai", "mobx", "valtio"],
    mobx: ["zustand", "redux", "jotai", "valtio"],
    zustand: ["jotai", "valtio", "redux"],
    joi: ["zod", "yup", "valibot", "ajv"],
    yup: ["zod", "joi", "valibot", "ajv"],
    zod: ["valibot", "yup", "joi", "ajv"],
    jest: ["vitest", "mocha", "ava"],
    mocha: ["vitest", "jest", "ava"],
    chai: ["vitest", "jest"],
    webpack: ["vite", "esbuild", "rollup", "parcel"],
    rollup: ["vite", "esbuild", "webpack"],
    parcel: ["vite", "webpack", "esbuild"],
    bootstrap: ["tailwindcss", "bulma", "foundation-sites"],
    tailwindcss: ["unocss", "bootstrap"],
    sequelize: ["prisma", "drizzle-orm", "typeorm", "knex"],
    typeorm: ["prisma", "drizzle-orm", "sequelize"],
    prisma: ["drizzle-orm", "typeorm", "sequelize"],
    lodash: ["radash", "remeda", "rambda"],
    underscore: ["lodash", "radash"],
    express: ["fastify", "koa", "hono", "@hapi/hapi"],
    koa: ["fastify", "express", "hono"],
};
const ALTERNATIVE_NOTES = {
    "date-fns": {
        pros: ["Functions are imported one at a time", "Works on native Date objects", "Written in TypeScript"],
        cons: ["No chainable API"],
    },
    dayjs: {
        pros: ["API modeled on Moment", "Immutable date objects", "Features are added through plugins"],
        cons: ["Time zones and several formats need plugins"],
    },
    zod: {
        pros: ["Written in TypeScript", "Static types are inferred from schemas"],
        cons: ["Validation runs at runtime and adds to bundle size"],
    },
    valibot: {
        pros: ["Each validator is a separate import", "Written in TypeScript"],
        cons: ["Newer, with fewer third-party integrations"],
    },
    vitest: {
        pros: ["Shares Vite's config and plugins", "ES modules work without extra setup", "Jest-style describe, it and expect"],
        cons: ["Newer than Jest", "Some Jest plugins do not work with it"],
    },
    zustand: {
        pros: ["Stores are plain hooks", "No provider component needed", "Written in TypeScript"],
        cons: ["Smaller ecosystem than Redux", "No enforced store structure"],
    },
    prisma: {
        pros: ["Generated, typed query client", "Built-in migrations", "Prisma Studio data browser"],
        cons: ["Needs a code generation step", "Schema is written in Prisma's own language"],
    },
    "drizzle-orm": {
        pros: ["Queries read like SQL", "Schema is plain TypeScript with no code generation step"],
        cons: ["Newer, with less documentation than older ORMs"],
    },
    vite: {
        pros: ["Dev server serves native ES modules", "Hot module replacement", "Works with little configuration"],
        cons: ["Config and plugins differ from Webpack's", "Some Webpack plugins have no equivalent"],
    },
    fastify: {
        pros: ["JSON schema validation built in", "Plugin system", "Built-in logging"],
        cons: ["Middleware pattern differs from Express", "Express middleware needs an adapter plugin"],
    },
};
export function alternativeNotes() {
    return ALTERNATIVE_NOTES;
}
function getMigrationEffort(from, to) {
    const lowEffort = [
        ["moment", "dayjs"],
        ["axios", "ky"],
        ["lodash", "radash"],
        ["jest", "vitest"],
    ];
    const highEffort = [
        ["redux", "zustand"],
        ["webpack", "vite"],
        ["sequelize", "prisma"],
        ["express", "fastify"],
    ];
    const left = from.toLowerCase();
    const right = to.toLowerCase();
    for (const [a, b] of lowEffort) {
        if ((left === a && right === b) || (left === b && right === a)) {
            return "low";
        }
    }
    for (const [a, b] of highEffort) {
        if ((left === a && right === b) || (left === b && right === a)) {
            return "high";
        }
    }
    return "medium";
}
function getProsAndCons(packageName) {
    if (!Object.hasOwn(ALTERNATIVE_NOTES, packageName)) {
        return { pros: [], cons: [] };
    }
    return ALTERNATIVE_NOTES[packageName];
}
function recommendationFor(packageName, alternatives) {
    if (alternatives.length === 0)
        return undefined;
    const top = alternatives[0];
    if (typeof top.weeklyDownloads !== "number") {
        return "Weekly downloads were not available, so the alternatives are in curated order.";
    }
    let text = `"${top.name}" has the most weekly downloads of these (${top.weeklyDownloads.toLocaleString("en-US")}).`;
    const lowEffort = alternatives.find((item) => item !== top && item.migrationEffort === "low");
    if (lowEffort) {
        text += ` "${lowEffort.name}" is rated low migration effort from "${packageName}".`;
    }
    return text;
}
export async function findAlternatives(packageName) {
    const packageKey = packageName.toLowerCase();
    const knownAlternatives = Object.hasOwn(ALTERNATIVES_MAP, packageKey)
        ? ALTERNATIVES_MAP[packageKey]
        : [];
    if (knownAlternatives.length === 0) {
        return {
            original: packageName,
            alternatives: [],
            notLoaded: [],
            recommendation: `No curated alternatives found for "${packageName}". Consider searching npm for similar packages.`,
        };
    }
    const loaded = await Promise.all(knownAlternatives.map(async (altName) => {
        try {
            const npmData = await fetchPackageData(altName);
            if (!npmData)
                return { name: altName, reason: "not found on npm" };
            const downloads = await fetchDownloads(altName, "last-week");
            const githubData = await fetchRepoFromNpmUrl(repositoryUrl(npmData.repository));
            const { pros, cons } = getProsAndCons(altName);
            const alternative = {
                name: altName,
                ...(npmData.description ? { description: npmData.description } : {}),
                ...(typeof downloads?.downloads === "number" ? { weeklyDownloads: downloads.downloads } : {}),
                ...(typeof githubData?.stargazers_count === "number"
                    ? { githubStars: githubData.stargazers_count }
                    : {}),
                pros,
                cons,
                migrationEffort: getMigrationEffort(packageName, altName),
            };
            return alternative;
        }
        catch (error) {
            if (error instanceof NpmLookupError)
                return { name: altName, reason: error.message };
            const reason = error instanceof Error ? error.message : String(error);
            return { name: altName, reason };
        }
    }));
    const alternatives = [];
    const notLoaded = [];
    for (const entry of loaded) {
        if ("reason" in entry)
            notLoaded.push({ name: entry.name, reason: entry.reason });
        else
            alternatives.push(entry);
    }
    const withCounts = alternatives.filter((item) => typeof item.weeklyDownloads === "number");
    const withoutCounts = alternatives.filter((item) => typeof item.weeklyDownloads !== "number");
    withCounts.sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0));
    const ordered = [...withCounts, ...withoutCounts];
    const recommendation = recommendationFor(packageName, ordered);
    return {
        original: packageName,
        alternatives: ordered,
        notLoaded,
        ...(recommendation ? { recommendation } : {}),
    };
}
