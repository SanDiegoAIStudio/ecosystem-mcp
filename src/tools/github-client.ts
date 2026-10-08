/**
 * GitHub API Client
 *
 * Fetches repository data from GitHub.
 */

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  license: { spdx_id: string } | null;
  pushed_at: string;
  updated_at: string;
  archived: boolean;
  disabled: boolean;
}

function ownerAndRepo(path: string, bare: boolean): { owner: string; repo: string } | null {
  const clean = path.split(/[?#]/)[0];
  const parts = clean.split("/").filter((part) => part.length > 0);
  if (bare ? parts.length !== 2 : parts.length < 2) return null;
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  if (!/^[\w-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const text = url.trim();
  if (!text) return null;

  if (/^github:/i.test(text)) {
    return ownerAndRepo(text.slice("github:".length), false);
  }

  if (/^[A-Za-z][\w+.-]*:(?!\/\/)/.test(text)) return null;

  const scp = text.match(/^git@github\.com:(.+)$/i);
  if (scp) return ownerAndRepo(scp[1], false);

  const asUrl = text.match(/^[A-Za-z][\w+.-]*:\/\/([^/?#]+)([^?#]*)(?:[?#].*)?$/);
  if (asUrl) {
    const host = asUrl[1].replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    return ownerAndRepo(asUrl[2].replace(/^\//, ""), false);
  }

  const hostPath = text.match(/^(?:www\.)?github\.com[/:]([^?#]*)/i);
  if (hostPath) return ownerAndRepo(hostPath[1], false);

  return ownerAndRepo(text, true);
}

export async function fetchRepoFromNpmUrl(
  repoUrl: string | undefined
): Promise<GitHubRepo | null> {
  if (!repoUrl) return null;
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) return null;
  return fetchRepo(parsed.owner, parsed.repo);
}

export async function fetchRepo(
  owner: string,
  repo: string
): Promise<GitHubRepo | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "ecosystem-mcp",
    };

    // Use token if available
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Failed to fetch GitHub repo ${owner}/${repo}:`, error);
    return null;
  }
}
