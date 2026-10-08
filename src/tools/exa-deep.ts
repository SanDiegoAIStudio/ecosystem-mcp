/**
 * Exa Deep Search Client
 *
 * Shared client for Exa's Deep and Deep-Reasoning search types.
 * Deep conducts agentic research: it reasons about intent, spawns parallel
 * search agents, and synthesizes results with field-level citations.
 *
 * Use Deep for multi-step research with citations; use standard Exa search for direct lookups.
 *
 * API: POST https://api.exa.ai/search with type: "deep" | "deep-reasoning"
 *
 * Pricing (as of 2026-03):
 *   deep:           $12 / 1,000 requests  (4-12s latency)
 *   deep-reasoning:  $15 / 1,000 requests  (12-50s latency)
 */

// ============================================================================
// Types
// ============================================================================

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
    text?: boolean | { maxCharacters?: number };
    highlights?: boolean | { numSentences?: number; highlightsPerUrl?: number };
    summary?: { query?: string };
  };
}

export type ExaCategory =
  | "research paper"
  | "news"
  | "tweet"
  | "company"
  | "people"
  | "github"
  | "linkedin"
  | "pdf";

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
  citations: Array<{ url: string; title: string }>;
  confidence: "low" | "medium" | "high";
}

export interface ExaDeepResponse {
  requestId: string;
  results: ExaDeepResult[];
  output?: {
    content: string | Record<string, unknown>;
    grounding: ExaGroundingEntry[];
  };
  costDollars?: { total: number };
}

// ============================================================================
// Research endpoint types (async, for longer tasks)
// ============================================================================

export interface ExaResearchRequest {
  model: "exa-research" | "exa-research-pro";
  instructions: string;
  outputSchema?: Record<string, unknown>;
}

export interface ExaResearchTaskStatus {
  researchId: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: Record<string, unknown>;
  costDollars?: { total: number };
}

// ============================================================================
// Client
// ============================================================================

export class ExaDeepClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.exa.ai";

  constructor(apiKey?: string) {
    const key = apiKey || process.env.EXA_API_KEY;
    if (!key) {
      throw new Error("EXA_API_KEY required for Exa Deep client");
    }
    this.apiKey = key;
  }

  /**
   * Deep Search: agentic research with structured output + citations.
   *
   * Use "deep" for fast synthesis (4-12s).
   * Use "deep-reasoning" when the query requires multi-step reasoning (12-50s).
   */
  async deepSearch(request: ExaDeepRequest): Promise<ExaDeepResponse> {
    const body: Record<string, unknown> = {
      query: request.query,
      type: request.type,
      numResults: request.numResults ?? 10,
    };

    if (request.outputSchema) body.outputSchema = request.outputSchema;
    if (request.includeDomains?.length) body.includeDomains = request.includeDomains;
    if (request.excludeDomains?.length) body.excludeDomains = request.excludeDomains;
    if (request.startPublishedDate) body.startPublishedDate = request.startPublishedDate;
    if (request.endPublishedDate) body.endPublishedDate = request.endPublishedDate;
    if (request.category) body.category = request.category;
    if (request.contents) body.contents = request.contents;

    const response = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000), // Deep can take up to 50s
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Exa Deep error ${response.status}: ${err}`);
    }

    return (await response.json()) as ExaDeepResponse;
  }

  /**
   * Research endpoint: async, for tasks that need minutes of deep research.
   * Returns a researchId you poll until completion.
   *
   * Pricing: $5/1k queries + $5/1k pages + $5/1M reasoning tokens (research)
   *          $5/1k queries + $10/1k pages + $5/1M reasoning tokens (research-pro)
   */
  async createResearchTask(request: ExaResearchRequest): Promise<string> {
    const response = await fetch(`${this.baseUrl}/research/v1`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Exa Research error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as { researchId: string };
    return data.researchId;
  }

  async getResearchTask(researchId: string): Promise<ExaResearchTaskStatus> {
    const response = await fetch(`${this.baseUrl}/research/v1/${researchId}`, {
      headers: { "x-api-key": this.apiKey },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Exa Research poll error ${response.status}: ${err}`);
    }

    return (await response.json()) as ExaResearchTaskStatus;
  }

  /**
   * Poll a research task until completion or timeout.
   */
  async pollResearchTask(
    researchId: string,
    options: { maxWaitMs?: number; pollIntervalMs?: number } = {}
  ): Promise<ExaResearchTaskStatus> {
    const maxWait = options.maxWaitMs ?? 180_000; // 3 min default
    const interval = options.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      const status = await this.getResearchTask(researchId);
      if (status.status === "completed" || status.status === "failed") {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`Research task ${researchId} timed out after ${maxWait}ms`);
  }

  /**
   * Convenience: submit research and wait for result.
   */
  async research<T = Record<string, unknown>>(
    instructions: string,
    outputSchema?: Record<string, unknown>,
    model: "exa-research" | "exa-research-pro" = "exa-research"
  ): Promise<{ output: T; cost?: number }> {
    const researchId = await this.createResearchTask({
      model,
      instructions,
      outputSchema,
    });

    const result = await this.pollResearchTask(researchId);

    if (result.status === "failed") {
      throw new Error(`Research task ${researchId} failed`);
    }

    return {
      output: result.output as T,
      cost: result.costDollars?.total,
    };
  }
}

// ============================================================================
// Convenience functions
// ============================================================================

let _defaultClient: ExaDeepClient | null = null;

function getClient(): ExaDeepClient {
  if (!_defaultClient) {
    _defaultClient = new ExaDeepClient();
  }
  return _defaultClient;
}

/**
 * Quick deep search with structured output.
 */
export async function deepSearch(
  query: string,
  outputSchema?: Record<string, unknown>,
  options: Partial<ExaDeepRequest> = {}
): Promise<ExaDeepResponse> {
  return getClient().deepSearch({
    query,
    type: options.type ?? "deep",
    outputSchema,
    ...options,
  });
}

/**
 * Async research task with structured output.
 */
export async function research<T = Record<string, unknown>>(
  instructions: string,
  outputSchema?: Record<string, unknown>,
  model: "exa-research" | "exa-research-pro" = "exa-research"
): Promise<{ output: T; cost?: number }> {
  return getClient().research<T>(instructions, outputSchema, model);
}
