# Ecosystem MCP

MCP server for ecosystem intelligence -- research packages, find alternatives, compare options, and check security advisories from within Claude Code.

## Tools

The server lists eight tools.

| Tool | Description | Key |
|------|-------------|-----|
| `research_package` | Deep dive on a specific npm package (downloads, stars, security, maintenance, TS support, license) | none |
| `compare_packages` | Compare 2 to 5 packages side-by-side | none |
| `find_alternatives` | Find alternatives to a given package | none |
| `check_security` | Check for security advisories | none |
| `analyze_package_json` | Analyze a project's dependencies | none |
| `exa_deep_search` | Web research through Exa Deep search, with citations | `EXA_API_KEY` |
| `exa_research` | Longer research task through the Exa Research API | `EXA_API_KEY` |
| `get_trending` | Get trending packages in a category | none |

### Environment variables

- `EXA_API_KEY`: required by `exa_deep_search` and `exa_research` only. Without it those two tools answer `EXA_API_KEY required for Exa Deep client` and the other six keep working.
- `GITHUB_TOKEN`: optional. When set, it is sent to the GitHub API for repository stats and security advisories, which raises GitHub's rate limit.

### Known limits

- `check_security`, and the security counts inside `research_package` and `analyze_package_json`, return GitHub's 30 newest npm advisories whatever package you ask about. The `version` argument of `check_security` is accepted and ignored.
- No tool reads a package's latest version. `analyze_package_json` therefore marks every dependency `up-to-date`, and `research_package` leaves out `latestVersion`, `versionsBehind` and the last publish date.

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
