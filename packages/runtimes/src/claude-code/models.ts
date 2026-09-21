/**
 * `claudeCodeModels` — the models an environment's account may use (#453), as Claude Code itself lists them
 * (`supportedModels()`, what `/model` offers), on a query that is never prompted, so no model call is made. The
 * adapter's own list is fixed; this one follows the account (a model it has, like Fable, shows up). Any failure is
 * `null`: the web falls back to the runtime plugin's list.
 */

import { query as sdkQuery, type ModelInfo, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { childEnv } from '@sigx/ai-agent-claude-code';
import type { LocalEnvironment, ModelOption } from '@agentic/core';
import { accountEnv } from './env.js';

const DEFAULT_TIMEOUT_MS = 20_000;

/** Just the part of `query` the probe uses; a fake in tests. */
export type ModelsQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Pick<Query, 'supportedModels' | 'close'>;

export interface ClaudeCodeModelsOptions {
    readonly query?: ModelsQueryFn;
    /** The daemon's own environment, whose account variables are kept out of the probe. */
    readonly parentEnv: Readonly<Record<string, string | undefined>>;
    readonly pathToClaudeCodeExecutable?: string;
    /** A probe that has not answered by then is abandoned (`null`). Default 20 s. */
    readonly timeoutMs?: number;
}

/** One `supportedModels()` row as the platform names a model: `value` is what `--model` / `setModel` take. */
export function modelOptionOf(m: ModelInfo): ModelOption {
    return { id: m.value, ...(m.displayName ? { label: m.displayName } : {}), ...(m.description ? { description: m.description } : {}) };
}

export async function claudeCodeModels(env: LocalEnvironment, options: ClaudeCodeModelsOptions): Promise<readonly ModelOption[] | null> {
    const query: ModelsQueryFn = options.query ?? (sdkQuery as unknown as ModelsQueryFn);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Streaming input that never yields: the CLI starts, answers control requests, and is never prompted.
    let release: () => void = () => {};
    const idle = new Promise<void>((resolve) => (release = resolve));
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        await idle;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let q: ReturnType<ModelsQueryFn> | undefined;
    try {
        q = query({
            prompt,
            options: {
                env: childEnv(accountEnv(env, options.parentEnv), options.parentEnv as NodeJS.ProcessEnv),
                settingSources: [],
                ...(options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {})
            }
        });
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
        });
        const models = await Promise.race([q.supportedModels(), timeout]);
        return models.length ? models.map(modelOptionOf) : null;
    } catch {
        return null;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        try {
            q?.close();
        } catch {
            // already closed
        }
        release();
    }
}
