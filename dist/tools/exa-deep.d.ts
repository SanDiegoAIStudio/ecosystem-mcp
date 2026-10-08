/**
 * Exa Deep Search Client
 *
 * Shared client for Exa's Deep and Deep-Reasoning search types.
 * Deep conducts agentic research — it reasons about intent, spawns parallel
 * search agents, and synthesizes results with field-level citations.
 *
 * Use Deep when you need *research*, not just search results.
 * Use standard Exa search when you know exactly what you're looking for.
 *
 * API: POST https://api.exa.ai/search with type: "deep" | "deep-reasoning"
 *
 * Pricing (as of 2026-03):
 *   deep:           $12 / 1,000 requests  (4-12s latency)
 *   deep-reasoning:  $15 / 1,000 requests  (12-50s latency)
 */
export interface ExaDeepRequest {
    query: string;
    type: "deep" | "deep-reasoning";
    numResults?: number;
    outputSchema?: Record<string, unknown>;
    includeDomains?: string[];
    excludeDomains?: string[];
    startPublishedDate?: string;
    endPublishedDate?: string;
    category?: ExaCategory;
    contents?: {
        text?: boolean | {
            maxCharacters?: number;
        };
        highlights?: boolean | {
            numSentences?: number;
            highlightsPerUrl?: number;
        };
        summary?: {
            query?: string;
        };
    };
}
export type ExaCategory = "research paper" | "news" | "tweet" | "company" | "people" | "github" | "linkedin" | "pdf";
export interface ExaDeepResult {
    id: string;
    url: string;
    title: string;
    author?: string;
    publishedDate?: string;
    text?: string;
    highlights?: string[];
    summary?: string;
    score: number;
}
export interface ExaGroundingEntry {
    field: string;
    citations: Array<{
        url: string;
        title: string;
    }>;
    confidence: "low" | "medium" | "high";
}
export interface ExaDeepResponse {
    requestId: string;
    results: ExaDeepResult[];
    output?: {
        content: string | Record<string, unknown>;
        grounding: ExaGroundingEntry[];
    };
    costDollars?: {
        total: number;
    };
}
export interface ExaResearchRequest {
    model: "exa-research" | "exa-research-pro";
    instructions: string;
    outputSchema?: Record<string, unknown>;
}
export interface ExaResearchTaskStatus {
    researchId: string;
    status: "pending" | "running" | "completed" | "failed";
    output?: Record<string, unknown>;
    costDollars?: {
        total: number;
    };
}
export declare class ExaDeepClient {
    private readonly apiKey;
    private readonly baseUrl;
    constructor(apiKey?: string);
    /**
     * Deep Search — agentic research with structured output + citations.
     *
     * Use "deep" for fast synthesis (4-12s).
     * Use "deep-reasoning" when the query requires multi-step reasoning (12-50s).
     */
    deepSearch(request: ExaDeepRequest): Promise<ExaDeepResponse>;
    /**
     * Research endpoint — async, for tasks that need minutes of deep research.
     * Returns a researchId you poll until completion.
     *
     * Pricing: $5/1k queries + $5/1k pages + $5/1M reasoning tokens (research)
     *          $5/1k queries + $10/1k pages + $5/1M reasoning tokens (research-pro)
     */
    createResearchTask(request: ExaResearchRequest): Promise<string>;
    getResearchTask(researchId: string): Promise<ExaResearchTaskStatus>;
    /**
     * Poll a research task until completion or timeout.
     */
    pollResearchTask(researchId: string, options?: {
        maxWaitMs?: number;
        pollIntervalMs?: number;
    }): Promise<ExaResearchTaskStatus>;
    /**
     * Convenience: submit research and wait for result.
     */
    research<T = Record<string, unknown>>(instructions: string, outputSchema?: Record<string, unknown>, model?: "exa-research" | "exa-research-pro"): Promise<{
        output: T;
        cost?: number;
    }>;
}
/**
 * Quick deep search with structured output.
 */
export declare function deepSearch(query: string, outputSchema?: Record<string, unknown>, options?: Partial<ExaDeepRequest>): Promise<ExaDeepResponse>;
/**
 * Async research task with structured output.
 */
export declare function research<T = Record<string, unknown>>(instructions: string, outputSchema?: Record<string, unknown>, model?: "exa-research" | "exa-research-pro"): Promise<{
    output: T;
    cost?: number;
}>;
