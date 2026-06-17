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
     * Deep Search — agentic research with structured output + citations.
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
     * Research endpoint — async, for tasks that need minutes of deep research.
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
// Preset Schemas — reusable output schemas for common research patterns
// ============================================================================
export const SCHEMAS = {
    /**
     * Company profile enrichment — for lead enrichment & competitive intel.
     */
    companyProfile: {
        type: "object",
        properties: {
            name: { type: "string", description: "Company legal name" },
            website: { type: "string", description: "Primary website URL" },
            industry: { type: "string", description: "Primary industry" },
            employeeCount: { type: "string", description: "Estimated employee count range (e.g. '11-50', '51-200')" },
            revenue: { type: "string", description: "Estimated annual revenue range" },
            founded: { type: "number", description: "Year founded" },
            headquarters: { type: "string", description: "HQ city and state/country" },
            description: { type: "string", description: "One paragraph company description" },
            recentNews: {
                type: "array",
                description: "Most notable recent developments",
                items: {
                    type: "object",
                    properties: {
                        headline: { type: "string" },
                        date: { type: "string" },
                        significance: { type: "string" },
                    },
                },
            },
            techStack: {
                type: "array",
                description: "Known technologies used",
                items: { type: "string" },
            },
            socialProfiles: {
                type: "object",
                properties: {
                    linkedin: { type: "string" },
                    twitter: { type: "string" },
                },
            },
        },
    },
    /**
     * Pre-call briefing — everything a salesperson needs before picking up the phone.
     */
    preCallBriefing: {
        type: "object",
        properties: {
            companySnapshot: {
                type: "object",
                description: "Quick company context",
                properties: {
                    name: { type: "string" },
                    industry: { type: "string" },
                    size: { type: "string" },
                    whatTheyDo: { type: "string", description: "One sentence on their core business" },
                },
            },
            recentDevelopments: {
                type: "array",
                description: "Things that happened in the last 6 months worth mentioning",
                items: {
                    type: "object",
                    properties: {
                        event: { type: "string" },
                        whyItMatters: { type: "string", description: "Why this matters for the sales conversation" },
                    },
                },
            },
            likelyPainPoints: {
                type: "array",
                description: "Business challenges this company likely faces based on their industry, size, and recent events",
                items: { type: "string" },
            },
            competitiveLandscape: {
                type: "array",
                description: "Their main competitors",
                items: { type: "string" },
            },
            talkingPoints: {
                type: "array",
                description: "Specific things to bring up in the call that show you've done your homework",
                items: { type: "string" },
            },
            avoidTopics: {
                type: "array",
                description: "Sensitive topics to avoid (layoffs, lawsuits, controversies)",
                items: { type: "string" },
            },
        },
    },
    /**
     * Competitive landscape — for competitive intelligence service.
     */
    competitiveLandscape: {
        type: "object",
        properties: {
            competitors: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        website: { type: "string" },
                        positioning: { type: "string", description: "How they position themselves" },
                        strengths: { type: "array", items: { type: "string" } },
                        weaknesses: { type: "array", items: { type: "string" } },
                        pricingModel: { type: "string", description: "How they charge (per seat, flat rate, etc.)" },
                        estimatedSize: { type: "string" },
                    },
                },
            },
            marketTrends: {
                type: "array",
                description: "Current trends in this market",
                items: {
                    type: "object",
                    properties: {
                        trend: { type: "string" },
                        impact: { type: "string", description: "How this trend affects competition" },
                    },
                },
            },
            opportunities: {
                type: "array",
                description: "Gaps in the market that competitors aren't addressing",
                items: { type: "string" },
            },
        },
    },
    /**
     * Meeting prep — for Claw Bridge meeting intelligence.
     */
    meetingPrep: {
        type: "object",
        properties: {
            attendees: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        role: { type: "string" },
                        background: { type: "string", description: "Brief professional background" },
                        recentActivity: { type: "string", description: "Any recent public posts, talks, or publications" },
                    },
                },
            },
            companyContext: {
                type: "string",
                description: "What the company does and any recent news",
            },
            suggestedAgenda: {
                type: "array",
                description: "Topics worth discussing based on the research",
                items: { type: "string" },
            },
            sharedConnections: {
                type: "array",
                description: "Common interests, mutual connections, or shared experiences",
                items: { type: "string" },
            },
        },
    },
    /**
     * Ghost trail discovery — for FutureTree strategic paths.
     */
    strategicPath: {
        type: "object",
        properties: {
            companyName: { type: "string" },
            startingState: {
                type: "object",
                properties: {
                    stage: { type: "string", description: "Where the company started (e.g. 'bootstrapped SaaS, 5 employees')" },
                    revenue: { type: "string" },
                    challenges: { type: "array", items: { type: "string" } },
                },
            },
            strategy: { type: "string", description: "The core strategic move they made" },
            steps: {
                type: "array",
                description: "Concrete steps taken, in chronological order",
                items: {
                    type: "object",
                    properties: {
                        action: { type: "string" },
                        timeframe: { type: "string" },
                        outcome: { type: "string" },
                    },
                },
            },
            endState: {
                type: "object",
                properties: {
                    stage: { type: "string" },
                    revenue: { type: "string" },
                    keyMetrics: { type: "array", items: { type: "string" } },
                },
            },
            lessonsLearned: { type: "array", items: { type: "string" } },
            timelineMonths: { type: "number", description: "Total timeline in months" },
        },
    },
    /**
     * Opportunity scouting — for weekly opportunity scanner.
     */
    freelanceOpportunity: {
        type: "object",
        properties: {
            opportunities: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        platform: { type: "string", description: "Where this was posted" },
                        url: { type: "string" },
                        budget: { type: "string" },
                        skills: { type: "array", items: { type: "string" } },
                        fitScore: { type: "string", description: "How well this matches the candidate's skills: high, medium, low" },
                        fitReason: { type: "string", description: "Why this is a good/bad match" },
                        postedDate: { type: "string" },
                    },
                },
            },
            marketInsight: { type: "string", description: "Brief observation about demand patterns for these skills" },
        },
    },
    /**
     * Site intelligence — website/domain research.
     */
    siteProfile: {
        type: "object",
        properties: {
            domain: { type: "string" },
            companyName: { type: "string" },
            techStack: {
                type: "array",
                description: "Technologies detected or mentioned",
                items: { type: "string" },
            },
            cms: { type: "string", description: "Content management system if identifiable" },
            hostingProvider: { type: "string" },
            hasEcommerce: { type: "boolean" },
            estimatedTraffic: { type: "string", description: "Traffic tier estimate" },
            seoObservations: {
                type: "array",
                description: "Notable SEO characteristics from public data",
                items: { type: "string" },
            },
            competitorSites: {
                type: "array",
                description: "Similar sites in the same space",
                items: { type: "string" },
            },
        },
    },
    /**
     * Topic enrichment — for Aiteur content production.
     */
    topicEnrichment: {
        type: "object",
        properties: {
            topic: { type: "string" },
            keyFacts: {
                type: "array",
                description: "Verified facts about this topic from authoritative sources",
                items: {
                    type: "object",
                    properties: {
                        fact: { type: "string" },
                        source: { type: "string" },
                    },
                },
            },
            expertVoices: {
                type: "array",
                description: "People quoted or cited as experts on this topic",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        affiliation: { type: "string" },
                        quote: { type: "string" },
                    },
                },
            },
            counterpoints: {
                type: "array",
                description: "Opposing views or nuances to the mainstream take",
                items: { type: "string" },
            },
            angles: {
                type: "array",
                description: "Unique content angles that haven't been covered much",
                items: { type: "string" },
            },
            relatedTopics: {
                type: "array",
                description: "Adjacent topics worth mentioning or linking to",
                items: { type: "string" },
            },
        },
    },
    /**
     * OpenClaw competitive scan — living market map.
     */
    marketScan: {
        type: "object",
        properties: {
            players: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        category: { type: "string", description: "What part of the space they occupy" },
                        stage: { type: "string", description: "Startup, growth, established" },
                        recentMoves: { type: "array", items: { type: "string" } },
                        funding: { type: "string" },
                    },
                },
            },
            emergingNiches: {
                type: "array",
                description: "Underserved areas where demand exists but supply is thin",
                items: {
                    type: "object",
                    properties: {
                        niche: { type: "string" },
                        evidence: { type: "string" },
                        opportunitySize: { type: "string" },
                    },
                },
            },
            shifts: {
                type: "array",
                description: "Strategic shifts happening in the market right now",
                items: {
                    type: "object",
                    properties: {
                        shift: { type: "string" },
                        drivers: { type: "string" },
                        implications: { type: "string" },
                    },
                },
            },
        },
    },
};
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
