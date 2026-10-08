/**
 * Exa Deep Search Client
 *
 * Shared client for Exa's Deep and Deep-Reasoning search types.
 * Deep conducts agentic research: it reasons about intent, spawns parallel
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
// ============================================================================
// Client
// ============================================================================
export class ExaDeepClient {
    apiKey;
    baseUrl = "https://api.exa.ai";
    constructor(apiKey) {
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
    async deepSearch(request) {
        const body = {
            query: request.query,
            type: request.type,
            numResults: request.numResults ?? 10,
        };
        if (request.outputSchema)
            body.outputSchema = request.outputSchema;
        if (request.includeDomains?.length)
            body.includeDomains = request.includeDomains;
        if (request.excludeDomains?.length)
            body.excludeDomains = request.excludeDomains;
        if (request.startPublishedDate)
            body.startPublishedDate = request.startPublishedDate;
        if (request.endPublishedDate)
            body.endPublishedDate = request.endPublishedDate;
        if (request.category)
            body.category = request.category;
        if (request.contents)
            body.contents = request.contents;
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
        return (await response.json());
    }
    /**
     * Research endpoint: async, for tasks that need minutes of deep research.
     * Returns a researchId you poll until completion.
     *
     * Pricing: $5/1k queries + $5/1k pages + $5/1M reasoning tokens (research)
     *          $5/1k queries + $10/1k pages + $5/1M reasoning tokens (research-pro)
     */
    async createResearchTask(request) {
        const response = await fetch(`${this.baseUrl}/research/v1`, {
            method: "POST",
            headers: {
                "x-api-key": this.apiKey,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Exa Research error ${response.status}: ${err}`);
        }
        const data = (await response.json());
        return data.researchId;
    }
    async getResearchTask(researchId) {
        const response = await fetch(`${this.baseUrl}/research/v1/${researchId}`, {
            headers: { "x-api-key": this.apiKey },
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Exa Research poll error ${response.status}: ${err}`);
        }
        return (await response.json());
    }
    /**
     * Poll a research task until completion or timeout.
     */
    async pollResearchTask(researchId, options = {}) {
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
    async research(instructions, outputSchema, model = "exa-research") {
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
            output: result.output,
            cost: result.costDollars?.total,
        };
    }
}
// ============================================================================
// Convenience functions
// ============================================================================
let _defaultClient = null;
function getClient() {
    if (!_defaultClient) {
        _defaultClient = new ExaDeepClient();
    }
    return _defaultClient;
}
/**
 * Quick deep search with structured output.
 */
export async function deepSearch(query, outputSchema, options = {}) {
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
export async function research(instructions, outputSchema, model = "exa-research") {
    return getClient().research(instructions, outputSchema, model);
}
