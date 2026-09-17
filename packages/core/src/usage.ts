/** Token usage. Open record with the well-known keys `@sigx/ai` documents, so provider extras survive. */
export interface Usage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number;
    readonly reasoningTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly [key: string]: number | undefined;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
    const out: Record<string, number | undefined> = { ...a };
    for (const [k, v] of Object.entries(b)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
    return out as unknown as Usage;
}

/** A usage row in the Ledger (OPS-07): estimates are flagged, never presented as fact. */
export interface UsageRow {
    readonly at: number;
    readonly sessionId: string;
    readonly agentId: string;
    readonly taskId?: string;
    readonly usage: Usage;
    readonly costUsd?: number;
    readonly estimated: boolean;
}
