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

const tools: Tool[] = [
  {
    name: "research_package",
    description: `Research an npm package in depth. Returns:
- Current vs latest version
- Weekly downloads, GitHub stars
- Security advisories
- Maintenance status (last commit, open issues)
- TypeScript support
- License info
- Bundle size (if available)

Use this when you need to evaluate a package before recommending it.`,
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "npm package name (e.g., 'react', 'lodash', '@tanstack/query')",
        },
        currentVersion: {
          type: "string",
          description: "Optional: Current version in use (for comparison)",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "compare_packages",
    description: `Compare multiple npm packages side-by-side. Returns a comparison table with:
- Downloads, stars, maintenance
- Bundle sizes
- TypeScript support
- Last update dates

Use this when helping choose between alternatives.`,
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
    description: `Find alternative packages to a given package. Returns:
- List of alternatives with pros/cons
- Migration effort estimate
- Popularity comparison

Use this when a package is deprecated, has security issues, or user wants options.`,
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Package to find alternatives for",
        },
        category: {
          type: "string",
          description: "Optional: Category hint (e.g., 'state-management', 'testing', 'date-library')",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "check_security",
    description: `Check for security advisories affecting a package or version. Returns:
- Known vulnerabilities (CVEs)
- Severity levels
- Patched versions
- Recommended actions

Use this before recommending a package or when auditing dependencies.`,
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Package name to check",
        },
        version: {
          type: "string",
          description: "Optional: Specific version to check",
        },
      },
      required: ["package"],
    },
  },
  {
    name: "analyze_package_json",
    description: `Analyze a package.json file and provide recommendations. Returns:
- Outdated dependencies
- Security vulnerabilities
- Deprecated packages
- Suggested updates with breaking change warnings

Use this to audit a project's dependencies.`,
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
    description: `Get trending/popular packages in a category. Returns:
- Top packages by downloads
- Rising packages (fast growth)
- Category recommendations

Categories: state-management, testing, ui-components, date-time, validation, http-client, orm, bundler, css-framework, animation`,
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
        framework: {
          type: "string",
          description: "Optional: Framework context (react, vue, svelte, node)",
        },
      },
      required: ["category"],
    },
  },
];

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

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "research_package":
        result = await researchPackage(
          args?.package as string,
          args?.currentVersion as string | undefined
        );
        break;

      case "compare_packages":
        result = await comparePackages(args?.packages as string[]);
        break;

      case "find_alternatives":
        result = await findAlternatives(
          args?.package as string,
          args?.category as string | undefined
        );
        break;

      case "check_security":
        result = await checkSecurity(
          args?.package as string,
          args?.version as string | undefined
        );
        break;

      case "analyze_package_json":
        result = await analyzePackageJson(
          args?.packageJson as Record<string, unknown>,
          args?.checkDevDeps as boolean | undefined
        );
        break;

      case "exa_deep_search": {
        result = await deepSearch(
          args?.query as string,
          args?.outputSchema as Record<string, unknown> | undefined,
          {
            type: (args?.type as "deep" | "deep-reasoning") ?? "deep",
            numResults: args?.numResults as number | undefined,
            includeDomains: args?.includeDomains as string[] | undefined,
            category: args?.category as "news" | "company" | "people" | undefined,
          }
        );
        break;
      }

      case "exa_research": {
        result = await research(
          args?.instructions as string,
          args?.outputSchema as Record<string, unknown> | undefined,
          (args?.model as "exa-research" | "exa-research-pro") ?? "exa-research"
        );
        break;
      }

      case "get_trending":
        result = await getTrending(
          args?.category as string,
          args?.framework as string | undefined
        );
        break;

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
});

// =============================================================================
// START SERVER
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ecosystem MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
