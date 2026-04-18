# Ecosystem MCP Agent Instructions

Read `CLAUDE.md` first. This repo is a TypeScript MCP server for npm package intelligence.

## Commands

```bash
bun install
bun run build
bun run dev
bun run start
bunx @anthropic-ai/mcp-inspector tsx src/index.ts
```

## Rules

- Keep tool schemas stable and Zod-validated.
- Do not add auth or network side effects without explicit need.
- Prefer public registry APIs and deterministic output.
- Build before claiming server changes are ready.

