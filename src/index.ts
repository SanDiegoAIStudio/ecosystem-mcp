#!/usr/bin/env node
/**
 * Ecosystem Intelligence MCP Server
 *
 * Provides Claude with tools to research packages, find alternatives,
 * check security advisories, and get ecosystem recommendations.
 *
 * Tools:
 * - research_package: Deep dive on a specific npm package
 * - compare_packages: Compare multiple packages side-by-side
 * - find_alternatives: Find alternatives to a package
 * - check_security: Check for security advisories
 * - analyze_package_json: Analyze a project's dependencies
 * - exa_deep_search: Web research through Exa Deep search
 * - exa_research: Longer research task through the Exa Research API
 * - get_trending: Get trending packages in a category
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  researchPackage,
  comparePackages,
  findAlternatives,
  checkSecurity,
  analyzePackageJson,
  getTrending,
  deepSearch,
  research,
} from "./tools/index.js";

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

export const tools: Tool[] = [
  {
    name: "research_package",
    description: "Research one npm package. Returns the latest version, weekly and monthly downloads, GitHub stars, forks, open issues, last push and whether the repository is archived, the security advisories that affect one version (the version in use when currentVersion is given, otherwise the latest), days since the last publish, maintainer count, whether type definitions are bundled, the license, and npm's deprecation notice when there is one. With currentVersion it also returns how many stable releases behind that version is.",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "npm package name (e.g., 'react', 'lodash', '@tanstack/query')",
        },
        currentVersion: {
          type: "string",
          description: "Optional: the version or range in use",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "compare_packages",
    description: "Compare 2 to 5 npm packages. For each one: latest version, weekly downloads, GitHub stars, last publish date, whether type definitions are bundled, license and maintainer count. A package that is missing or could not be read is marked as such.",
    inputSchema: {
      type: "object",
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          description: "List of package names to compare (2-5 packages)",
          minItems: 2,
          maxItems: 5,
        },
      },
      required: ["packages"],
    },
  },
  {
    name: "find_alternatives",
    description: "List curated alternatives to a well-known npm package, each with weekly downloads, GitHub stars, short notes for and against, and a rough migration effort. Packages outside the curated list return an empty list.",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Package to find alternatives for",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "check_security",
    description: "List the security advisories that affect one version of an npm package: the version given, or the latest version when none is given. Returns the version checked, counts by severity, and each advisory with its vulnerable and patched ranges.",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Package name to check",
        },
        version: {
          type: "string",
          description: "Optional: a version or range to check. Default: the latest version",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "analyze_package_json",
    description: "Check a package.json's dependencies against npm. For each one: whether it is behind (patch, minor or major), how many advisories affect the version in use, and npm's deprecation notice. It looks at the first 20 dependencies and the first 10 devDependencies and says so when there are more. Dependencies that point at a workspace, a file, a git repository or a URL are not looked up.",
    inputSchema: {
      type: "object",
      properties: {
        packageJson: {
          type: "object",
          description: "The package.json content as an object",
        },
        checkDevDeps: {
          type: "boolean",
          description: "Also analyze devDependencies (default: true)",
          default: true,
        },
      },
      required: ["packageJson"],
    },
  },
  {
    name: "exa_deep_search",
    description: `Agentic deep search using Exa Deep. Conducts multi-step research with query expansion,
parallel search agents, and LLM synthesis. Returns structured results with field-level citations.

Use "deep" (4-12s) for fast synthesis. Use "deep-reasoning" (12-50s) for complex multi-step research.

Supports outputSchema for structured JSON responses with grounding citations.
Requires EXA_API_KEY environment variable.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language research query",
        },
        type: {
          type: "string",
          enum: ["deep", "deep-reasoning"],
          description: "Search depth: 'deep' (fast) or 'deep-reasoning' (thorough)",
          default: "deep",
        },
        outputSchema: {
          type: "object",
          description: "Optional JSON Schema for structured output. Deep will return data matching this schema with field-level citations.",
        },
        numResults: {
          type: "number",
          description: "Number of source results (default: 10)",
        },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Restrict search to these domains",
        },
        category: {
          type: "string",
          enum: ["research paper", "news", "tweet", "company", "people", "github", "linkedin", "pdf"],
          description: "Filter to specific content category",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "exa_research",
    description: `Submit an async deep research task to Exa Research API. For research that needs minutes
of deep investigation (45-180s). Returns structured results with citations.

Use exa-research (faster, cheaper) or exa-research-pro (more thorough).
Polls until completion and returns the final result.`,
    inputSchema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "Natural language research instructions (max 4096 chars)",
        },
        outputSchema: {
          type: "object",
          description: "Optional JSON Schema for structured output (max 8 root fields, 5 levels deep)",
        },
        model: {
          type: "string",
          enum: ["exa-research", "exa-research-pro"],
          description: "Research model (default: exa-research)",
          default: "exa-research",
        },
      },
      required: ["instructions"],
    },
  },
  {
    name: "get_trending",
    description: "Popular packages in a category, from a curated list, with weekly downloads, GitHub stars and a rising, stable or declining label that compares the last week with the last month. Categories: state-management, testing, ui-components, date-time, validation, http-client, orm, bundler, css-framework, animation",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Category to search",
          enum: [
            "state-management",
            "testing",
            "ui-components",
            "date-time",
            "validation",
            "http-client",
            "orm",
            "bundler",
            "css-framework",
            "animation",
          ],
        },
      },
      required: ["category"],
    },
  },
];

// =============================================================================
// ARGUMENT SCHEMAS
// =============================================================================

const nonEmptyString = z.string().min(1);
const dependencyMap = z.record(z.string(), z.string());

const researchPackageArgs = z.object({
  package: nonEmptyString,
  currentVersion: z.string().optional(),
});

const comparePackagesArgs = z.object({
  packages: z.array(nonEmptyString).min(2).max(5),
});

const findAlternativesArgs = z.object({
  package: nonEmptyString,
});

const checkSecurityArgs = z.object({
  package: nonEmptyString,
  version: z.string().optional(),
});

const analyzePackageJsonArgs = z.object({
  packageJson: z
    .object({
      dependencies: dependencyMap.optional(),
      devDependencies: dependencyMap.optional(),
    })
    .passthrough(),
  checkDevDeps: z.boolean().optional(),
});

const exaCategory = z.enum([
  "research paper",
  "news",
  "tweet",
  "company",
  "people",
  "github",
  "linkedin",
  "pdf",
]);

const exaDeepSearchArgs = z.object({
  query: nonEmptyString,
  type: z.enum(["deep", "deep-reasoning"]).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  numResults: z.number().optional(),
  includeDomains: z.array(z.string()).optional(),
  category: exaCategory.optional(),
});

const exaResearchArgs = z.object({
  instructions: nonEmptyString,
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  model: z.enum(["exa-research", "exa-research-pro"]).optional(),
});

const getTrendingArgs = z.object({
  category: z.enum([
    "state-management",
    "testing",
    "ui-components",
    "date-time",
    "validation",
    "http-client",
    "orm",
    "bundler",
    "css-framework",
    "animation",
  ]),
});

interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function invalidArguments(tool: string, error: z.ZodError): ToolTextResult {
  const issue = error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "arguments";
  const detail = issue?.message ?? "Invalid input";
  return {
    content: [
      {
        type: "text",
        text: `Invalid arguments for ${tool}: ${field}: ${detail}`,
      },
    ],
    isError: true,
  };
}

function readArgs<T>(
  tool: string,
  schema: z.ZodType<T>,
  args: unknown
): { ok: true; data: T } | { ok: false; result: ToolTextResult } {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, result: invalidArguments(tool, parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

export async function handleToolCall(request: {
  params: { name: string; arguments?: unknown };
}): Promise<ToolTextResult> {
  const { name } = request.params;
  const rawArgs = request.params.arguments ?? {};

  try {
    let result: unknown;

    switch (name) {
      case "research_package": {
        const parsed = readArgs(name, researchPackageArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        result = await researchPackage(parsed.data.package, parsed.data.currentVersion);
        break;
      }

      case "compare_packages": {
        const parsed = readArgs(name, comparePackagesArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        result = await comparePackages(parsed.data.packages);
        break;
      }

      case "find_alternatives": {
        const parsed = readArgs(name, findAlternativesArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        result = await findAlternatives(parsed.data.package);
        break;
      }

      case "check_security": {
        const parsed = readArgs(name, checkSecurityArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        result = await checkSecurity(parsed.data.package, parsed.data.version);
        break;
      }

      case "analyze_package_json": {
        const parsed = readArgs(name, analyzePackageJsonArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        const packageJson: Record<string, unknown> = { ...parsed.data.packageJson };
        result = await analyzePackageJson(packageJson, parsed.data.checkDevDeps);
        break;
      }

      case "exa_deep_search": {
        const parsed = readArgs(name, exaDeepSearchArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        result = await deepSearch(parsed.data.query, parsed.data.outputSchema, {
          type: parsed.data.type ?? "deep",
          numResults: parsed.data.numResults,
          includeDomains: parsed.data.includeDomains,
          category: parsed.data.category,
        });
        break;
      }

      case "exa_research": {
        const parsed = readArgs(name, exaResearchArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        result = await research(
          parsed.data.instructions,
          parsed.data.outputSchema,
          parsed.data.model ?? "exa-research"
        );
        break;
      }

      case "get_trending": {
        const parsed = readArgs(name, getTrendingArgs, rawArgs);
        if (!parsed.ok) return parsed.result;
        result = await getTrending(parsed.data.category);
        break;
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }

    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
}

// =============================================================================
// SERVER SETUP
// =============================================================================

const server = new Server(
  {
    name: "ecosystem-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Handle tool calls. The object is built here so it matches the SDK result type.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const outcome = await handleToolCall(request);
  const text = outcome.content[0]?.text ?? "";
  if (outcome.isError) {
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
  };
});

// =============================================================================
// START SERVER
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ecosystem MCP server running on stdio");
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
