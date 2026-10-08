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
import { Tool } from "@modelcontextprotocol/sdk/types.js";
export declare const tools: Tool[];
interface ToolTextResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
}
export declare function handleToolCall(request: {
    params: {
        name: string;
        arguments?: unknown;
    };
}): Promise<ToolTextResult>;
export declare function cliEntryMatches(modulePath: string, entryPath: string): boolean;
export {};
