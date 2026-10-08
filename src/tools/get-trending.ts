/**
 * Get Trending Tool
 *
 * Get trending/popular packages in a category.
 */

import { fetchDownloads, fetchPackageData, NpmLookupError, repositoryUrl } from "./npm-client.js";
import { fetchRepoFromNpmUrl } from "./github-client.js";

const CATEGORY_PACKAGES: Record<string, string[]> = {
  "state-management": [
    "zustand",
    "jotai",
    "valtio",
    "redux",
    "@reduxjs/toolkit",
    "mobx",
    "xstate",
  ],
  testing: [
    "vitest",
    "jest",
    "@testing-library/react",
    "playwright",
    "cypress",
    "mocha",
    "ava",
  ],
  "ui-components": [
    "@radix-ui/react-dialog",
    "@headlessui/react",
    "@chakra-ui/react",
    "@mantine/core",
    "antd",
    "@mui/material",
    "shadcn",
  ],
  "date-time": ["date-fns", "dayjs", "luxon", "moment", "@formkit/tempo", "@internationalized/date"],
  validation: ["zod", "yup", "valibot", "ajv", "joi", "superstruct"],
  "http-client": ["axios", "ky", "got", "undici", "ofetch", "wretch"],
  orm: [
    "prisma",
    "drizzle-orm",
    "typeorm",
    "sequelize",
    "knex",
    "kysely",
    "mikro-orm",
  ],
  bundler: ["vite", "esbuild", "rollup", "webpack", "parcel", "tsup"],
  "css-framework": [
    "tailwindcss",
    "unocss",
    "bootstrap",
    "bulma",
    "styled-components",
    "@emotion/react",
  ],
  animation: [
    "framer-motion",
    "react-spring",
    "@react-spring/web",
    "gsap",
    "animejs",
    "motion",
  ],
};

export interface TrendingPackage {
  name: string;
  description?: string;
  weeklyDownloads: number;
  githubStars?: number;
  lastUpdate?: string;
  trending: "rising" | "stable" | "declining" | "unknown";
}

export interface TrendingResult {
  category: string;
  packages: TrendingPackage[];
  topPick?: string;
  risingStars: string[];
  notLoaded: Array<{ name: string; reason: string }>;
}

function trendLabel(weekly: number, monthly: number | undefined): TrendingPackage["trending"] {
  if (monthly === undefined) return "unknown";
  const weeklyAvg = (monthly * 7) / 30;
  if (weekly > weeklyAvg * 1.1) return "rising";
  if (weekly < weeklyAvg * 0.9) return "declining";
  return "stable";
}

export async function getTrending(category: string): Promise<TrendingResult> {
  if (!Object.hasOwn(CATEGORY_PACKAGES, category)) {
    throw new Error(
      `Unknown category: ${category}. Available: ${Object.keys(CATEGORY_PACKAGES).join(", ")}`
    );
  }
  const packageNames = CATEGORY_PACKAGES[category].slice(0, 8);

  const loaded = await Promise.all(
    packageNames.map(async (name) => {
      try {
        const npmData = await fetchPackageData(name);
        if (!npmData) return { name, reason: "not found on npm" };
        const [weeklyDownloads, monthlyDownloads] = await Promise.all([
          fetchDownloads(name, "last-week"),
          fetchDownloads(name, "last-month"),
        ]);
        if (!weeklyDownloads) return { name, reason: "weekly downloads unavailable" };
        const githubData = await fetchRepoFromNpmUrl(repositoryUrl(npmData.repository));
        const lastUpdate = npmData.time?.[npmData.version];
        const pkg: TrendingPackage = {
          name,
          description: npmData.description,
          weeklyDownloads: weeklyDownloads.downloads,
          ...(typeof githubData?.stargazers_count === "number"
            ? { githubStars: githubData.stargazers_count }
            : {}),
          ...(lastUpdate ? { lastUpdate } : {}),
          trending: trendLabel(weeklyDownloads.downloads, monthlyDownloads?.downloads),
        };
        return pkg;
      } catch (error) {
        if (error instanceof NpmLookupError) return { name, reason: error.message };
        const reason = error instanceof Error ? error.message : String(error);
        return { name, reason };
      }
    })
  );

  const packages: TrendingPackage[] = [];
  const notLoaded: Array<{ name: string; reason: string }> = [];
  for (const entry of loaded) {
    if ("reason" in entry) notLoaded.push(entry);
    else packages.push(entry);
  }

  packages.sort((a, b) => b.weeklyDownloads - a.weeklyDownloads);
  const risingStars = packages.filter((pkg) => pkg.trending === "rising").map((pkg) => pkg.name);

  return {
    category,
    packages,
    topPick: packages[0]?.name,
    risingStars,
    notLoaded,
  };
}
