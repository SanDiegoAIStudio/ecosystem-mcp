# Ecosystem MCP

MCP server for ecosystem intelligence: research packages, find alternatives, compare options, and check security advisories from within Claude Code.

## Tools

The server lists eight tools.

| Tool | Description | Key |
|------|-------------|-----|
| `research_package` | Deep dive on a specific npm package (downloads, stars, security, maintenance, TS support, license) | none |
| `compare_packages` | Compare 2 to 5 packages side-by-side | none |
| `find_alternatives` | Curated alternatives to a well-known package | none |
| `check_security` | Security advisories that affect one version of a package: the one you name, or the latest | none |
| `analyze_package_json` | Check a project's dependencies for updates, advisories and deprecations | none |
| `exa_deep_search` | Web research through Exa Deep search, with citations | `EXA_API_KEY` |
| `exa_research` | Longer research task through the Exa Research API | `EXA_API_KEY` |
| `get_trending` | Popular packages in a category, from a curated list | none |

### Environment variables

- `EXA_API_KEY`: required by `exa_deep_search` and `exa_research` only. Without it those two tools answer `EXA_API_KEY required for Exa Deep client` and the other six keep working.
- `GITHUB_TOKEN`: optional. When set, it is sent to the GitHub API for repository stats and security advisories. Without it GitHub allows 60 requests an hour, and `analyze_package_json` makes one advisory request per dependency; a lookup that fails is reported as failed, never as "no advisories".

### What it sends

The six package tools send package names to three public services: the npm registry (`registry.npmjs.org`), npm's download counts (`api.npmjs.org`) and the GitHub API (repository stats and security advisories). `analyze_package_json` sends the name of each dependency it looks at, up to the first 20 dependencies and the first 10 devDependencies. A dependency whose version points at a workspace, a file, a git repository or a URL is not looked up anywhere. The two Exa tools send your query to `api.exa.ai`.

Every request has a time limit: 15 seconds for npm and GitHub, 30 to 60 seconds for Exa. A lookup that fails or times out is reported as failed. It is never reported as "not found" or as zero advisories.

## Setup

```bash
git clone https://github.com/SanDiegoAIStudio/ecosystem-mcp.git
cd ecosystem-mcp

# Install dependencies
bun install

# Build
bun run build

# Run in development
bun run dev
```

## Usage with Claude Code

Register the built server, using the full path to your clone:

```bash
claude mcp add ecosystem-mcp -- node /path/to/ecosystem-mcp/dist/index.js
```

To pass a key for the two Exa tools:

```bash
claude mcp add ecosystem-mcp -e EXA_API_KEY=your-key -- node /path/to/ecosystem-mcp/dist/index.js
```

Or share it with a project by putting this in a `.mcp.json` file at the project root:

```json
{
  "mcpServers": {
    "ecosystem-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/ecosystem-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

`claude mcp list` shows whether the server connected. Inside Claude Code, `/mcp` lists the server and its tools.

Or run the inspector for testing:

```bash
bunx @modelcontextprotocol/inspector node dist/index.js
```

## Tests

```bash
bun test
```

The tests mock the npm registry and GitHub, so they need no network.

## Stack

- TypeScript (ESM)
- `@modelcontextprotocol/sdk` v1.0
- `zod` for schema validation
- Node 20+

## Project Structure

```
ecosystem-mcp/
  src/
    index.ts          # Server entry, tool definitions
    tools/            # Tool implementations
  dist/               # Built output
  package.json
  tsconfig.json
```

## License

MIT. See [LICENSE](LICENSE).
