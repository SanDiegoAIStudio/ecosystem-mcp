/**
 * GitHub API Client
 *
 * Fetches repository data from GitHub.
 */
export interface GitHubRepo {
    name: string;
    full_name: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    license: {
        spdx_id: string;
    } | null;
    pushed_at: string;
    updated_at: string;
    archived: boolean;
    disabled: boolean;
}
export declare function parseGitHubRepo(url: string): {
    owner: string;
    repo: string;
} | null;
export declare function fetchRepoFromNpmUrl(repoUrl: string | undefined): Promise<GitHubRepo | null>;
export declare function fetchRepo(owner: string, repo: string): Promise<GitHubRepo | null>;
