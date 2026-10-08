# Ecosystem MCP

**Type:** MCP server for package intelligence
**Language:** TypeScript (ESM)

## Commands

```bash
bun install          # Install deps
bun run build        # Build (tsc)
bun run dev          # Dev mode (tsx)
bun run start        # Production
```

## Structure

- `src/index.ts` -- Server entry, tool definitions
- `src/tools/` -- Tool implementations (research, compare, find, security, analyze, trending, Exa search)
- `dist/` -- Built output

## Tools Provided

Eight MCP tools, in the order the server lists them:
1. `research_package` -- Deep package research
2. `compare_packages` -- Side-by-side comparison
3. `find_alternatives` -- Alternative discovery
4. `check_security` -- Security advisory check
5. `analyze_package_json` -- Dependency analysis
6. `exa_deep_search` -- Web research through Exa Deep search (needs `EXA_API_KEY`)
7. `exa_research` -- Longer research task through the Exa Research API (needs `EXA_API_KEY`)
8. `get_trending` -- Trending packages by category

## Dependencies

- `@modelcontextprotocol/sdk` -- MCP protocol
- `zod` -- Schema validation
- `semver` -- Version parsing

## Notes

- Requires Node 20+
- The six package tools need no key (public registry APIs); the two Exa tools need `EXA_API_KEY`; `GITHUB_TOKEN` is optional
- Test with MCP inspector: `bunx @modelcontextprotocol/inspector node dist/index.js`
