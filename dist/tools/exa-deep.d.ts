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
export declare const SCHEMAS: {
    /**
     * Company profile enrichment — for lead enrichment & competitive intel.
     */
    readonly companyProfile: {
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Company legal name";
            };
            readonly website: {
                readonly type: "string";
                readonly description: "Primary website URL";
            };
            readonly industry: {
                readonly type: "string";
                readonly description: "Primary industry";
            };
            readonly employeeCount: {
                readonly type: "string";
                readonly description: "Estimated employee count range (e.g. '11-50', '51-200')";
            };
            readonly revenue: {
                readonly type: "string";
                readonly description: "Estimated annual revenue range";
            };
            readonly founded: {
                readonly type: "number";
                readonly description: "Year founded";
            };
            readonly headquarters: {
                readonly type: "string";
                readonly description: "HQ city and state/country";
            };
            readonly description: {
                readonly type: "string";
                readonly description: "One paragraph company description";
            };
            readonly recentNews: {
                readonly type: "array";
                readonly description: "Most notable recent developments";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly headline: {
                            readonly type: "string";
                        };
                        readonly date: {
                            readonly type: "string";
                        };
                        readonly significance: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly techStack: {
                readonly type: "array";
                readonly description: "Known technologies used";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly socialProfiles: {
                readonly type: "object";
                readonly properties: {
                    readonly linkedin: {
                        readonly type: "string";
                    };
                    readonly twitter: {
                        readonly type: "string";
                    };
                };
            };
        };
    };
    /**
     * Pre-call briefing — everything a salesperson needs before picking up the phone.
     */
    readonly preCallBriefing: {
        readonly type: "object";
        readonly properties: {
            readonly companySnapshot: {
                readonly type: "object";
                readonly description: "Quick company context";
                readonly properties: {
                    readonly name: {
                        readonly type: "string";
                    };
                    readonly industry: {
                        readonly type: "string";
                    };
                    readonly size: {
                        readonly type: "string";
                    };
                    readonly whatTheyDo: {
                        readonly type: "string";
                        readonly description: "One sentence on their core business";
                    };
                };
            };
            readonly recentDevelopments: {
                readonly type: "array";
                readonly description: "Things that happened in the last 6 months worth mentioning";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly event: {
                            readonly type: "string";
                        };
                        readonly whyItMatters: {
                            readonly type: "string";
                            readonly description: "Why this matters for the sales conversation";
                        };
                    };
                };
            };
            readonly likelyPainPoints: {
                readonly type: "array";
                readonly description: "Business challenges this company likely faces based on their industry, size, and recent events";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly competitiveLandscape: {
                readonly type: "array";
                readonly description: "Their main competitors";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly talkingPoints: {
                readonly type: "array";
                readonly description: "Specific things to bring up in the call that show you've done your homework";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly avoidTopics: {
                readonly type: "array";
                readonly description: "Sensitive topics to avoid (layoffs, lawsuits, controversies)";
                readonly items: {
                    readonly type: "string";
                };
            };
        };
    };
    /**
     * Competitive landscape — for competitive intelligence service.
     */
    readonly competitiveLandscape: {
        readonly type: "object";
        readonly properties: {
            readonly competitors: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly website: {
                            readonly type: "string";
                        };
                        readonly positioning: {
                            readonly type: "string";
                            readonly description: "How they position themselves";
                        };
                        readonly strengths: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly weaknesses: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly pricingModel: {
                            readonly type: "string";
                            readonly description: "How they charge (per seat, flat rate, etc.)";
                        };
                        readonly estimatedSize: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly marketTrends: {
                readonly type: "array";
                readonly description: "Current trends in this market";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly trend: {
                            readonly type: "string";
                        };
                        readonly impact: {
                            readonly type: "string";
                            readonly description: "How this trend affects competition";
                        };
                    };
                };
            };
            readonly opportunities: {
                readonly type: "array";
                readonly description: "Gaps in the market that competitors aren't addressing";
                readonly items: {
                    readonly type: "string";
                };
            };
        };
    };
    /**
     * Meeting prep — for Claw Bridge meeting intelligence.
     */
    readonly meetingPrep: {
        readonly type: "object";
        readonly properties: {
            readonly attendees: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly role: {
                            readonly type: "string";
                        };
                        readonly background: {
                            readonly type: "string";
                            readonly description: "Brief professional background";
                        };
                        readonly recentActivity: {
                            readonly type: "string";
                            readonly description: "Any recent public posts, talks, or publications";
                        };
                    };
                };
            };
            readonly companyContext: {
                readonly type: "string";
                readonly description: "What the company does and any recent news";
            };
            readonly suggestedAgenda: {
                readonly type: "array";
                readonly description: "Topics worth discussing based on the research";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly sharedConnections: {
                readonly type: "array";
                readonly description: "Common interests, mutual connections, or shared experiences";
                readonly items: {
                    readonly type: "string";
                };
            };
        };
    };
    /**
     * Ghost trail discovery — for FutureTree strategic paths.
     */
    readonly strategicPath: {
        readonly type: "object";
        readonly properties: {
            readonly companyName: {
                readonly type: "string";
            };
            readonly startingState: {
                readonly type: "object";
                readonly properties: {
                    readonly stage: {
                        readonly type: "string";
                        readonly description: "Where the company started (e.g. 'bootstrapped SaaS, 5 employees')";
                    };
                    readonly revenue: {
                        readonly type: "string";
                    };
                    readonly challenges: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly strategy: {
                readonly type: "string";
                readonly description: "The core strategic move they made";
            };
            readonly steps: {
                readonly type: "array";
                readonly description: "Concrete steps taken, in chronological order";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly action: {
                            readonly type: "string";
                        };
                        readonly timeframe: {
                            readonly type: "string";
                        };
                        readonly outcome: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly endState: {
                readonly type: "object";
                readonly properties: {
                    readonly stage: {
                        readonly type: "string";
                    };
                    readonly revenue: {
                        readonly type: "string";
                    };
                    readonly keyMetrics: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly lessonsLearned: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly timelineMonths: {
                readonly type: "number";
                readonly description: "Total timeline in months";
            };
        };
    };
    /**
     * Opportunity scouting — for weekly opportunity scanner.
     */
    readonly freelanceOpportunity: {
        readonly type: "object";
        readonly properties: {
            readonly opportunities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly title: {
                            readonly type: "string";
                        };
                        readonly platform: {
                            readonly type: "string";
                            readonly description: "Where this was posted";
                        };
                        readonly url: {
                            readonly type: "string";
                        };
                        readonly budget: {
                            readonly type: "string";
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly fitScore: {
                            readonly type: "string";
                            readonly description: "How well this matches the candidate's skills: high, medium, low";
                        };
                        readonly fitReason: {
                            readonly type: "string";
                            readonly description: "Why this is a good/bad match";
                        };
                        readonly postedDate: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly marketInsight: {
                readonly type: "string";
                readonly description: "Brief observation about demand patterns for these skills";
            };
        };
    };
    /**
     * Site intelligence — website/domain research.
     */
    readonly siteProfile: {
        readonly type: "object";
        readonly properties: {
            readonly domain: {
                readonly type: "string";
            };
            readonly companyName: {
                readonly type: "string";
            };
            readonly techStack: {
                readonly type: "array";
                readonly description: "Technologies detected or mentioned";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly cms: {
                readonly type: "string";
                readonly description: "Content management system if identifiable";
            };
            readonly hostingProvider: {
                readonly type: "string";
            };
            readonly hasEcommerce: {
                readonly type: "boolean";
            };
            readonly estimatedTraffic: {
                readonly type: "string";
                readonly description: "Traffic tier estimate";
            };
            readonly seoObservations: {
                readonly type: "array";
                readonly description: "Notable SEO characteristics from public data";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly competitorSites: {
                readonly type: "array";
                readonly description: "Similar sites in the same space";
                readonly items: {
                    readonly type: "string";
                };
            };
        };
    };
    /**
     * Topic enrichment — for Aiteur content production.
     */
    readonly topicEnrichment: {
        readonly type: "object";
        readonly properties: {
            readonly topic: {
                readonly type: "string";
            };
            readonly keyFacts: {
                readonly type: "array";
                readonly description: "Verified facts about this topic from authoritative sources";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly fact: {
                            readonly type: "string";
                        };
                        readonly source: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly expertVoices: {
                readonly type: "array";
                readonly description: "People quoted or cited as experts on this topic";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly affiliation: {
                            readonly type: "string";
                        };
                        readonly quote: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly counterpoints: {
                readonly type: "array";
                readonly description: "Opposing views or nuances to the mainstream take";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly angles: {
                readonly type: "array";
                readonly description: "Unique content angles that haven't been covered much";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly relatedTopics: {
                readonly type: "array";
                readonly description: "Adjacent topics worth mentioning or linking to";
                readonly items: {
                    readonly type: "string";
                };
            };
        };
    };
    /**
     * OpenClaw competitive scan — living market map.
     */
    readonly marketScan: {
        readonly type: "object";
        readonly properties: {
            readonly players: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly category: {
                            readonly type: "string";
                            readonly description: "What part of the space they occupy";
                        };
                        readonly stage: {
                            readonly type: "string";
                            readonly description: "Startup, growth, established";
                        };
                        readonly recentMoves: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly funding: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly emergingNiches: {
                readonly type: "array";
                readonly description: "Underserved areas where demand exists but supply is thin";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly niche: {
                            readonly type: "string";
                        };
                        readonly evidence: {
                            readonly type: "string";
                        };
                        readonly opportunitySize: {
                            readonly type: "string";
                        };
                    };
                };
            };
            readonly shifts: {
                readonly type: "array";
                readonly description: "Strategic shifts happening in the market right now";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly shift: {
                            readonly type: "string";
                        };
                        readonly drivers: {
                            readonly type: "string";
                        };
                        readonly implications: {
                            readonly type: "string";
                        };
                    };
                };
            };
        };
    };
};
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
