/**
 * The agents at work now, read off the session feeds (#1058): each feed mid-turn is one live line — who,
 * what it is doing (its newest step still running, else its newest step), and since when.
 */
import type { AgentTranscript } from '@sigx/ai-agent/app';
import { stepsFromToolParts } from '@agentic/ui';
import { inFlightMessages, sessionMidTurn, type AgentLookup, type SessionFeed } from '../live';
import type { LiveWork } from './types';

/** `Edit · packages/ui/package.json`: the step the turn is on; `undefined` before its first call. */
export function currentStep(transcript: AgentTranscript): string | undefined {
    const steps = inFlightMessages(transcript).flatMap((m) => stepsFromToolParts(m, transcript).steps);
    const step = [...steps].reverse().find((s) => s.state === 'running' || s.state === 'pending') ?? steps[steps.length - 1];
    if (!step) return undefined;
    return step.target ? `${step.tool} · ${step.target}` : step.tool;
}

/** A feed with the time its current turn started (`feeds.ts` records it). */
export type TimedFeed = SessionFeed & { readonly turnStartedAt?: number };

/**
 * One `LiveWork` per feed mid-turn, in the order given. `now` stands in for a turn whose start the feed did
 * not see; `stop` makes each line's Stop.
 */
export function liveWorkOf(feeds: readonly TimedFeed[], lookup: AgentLookup, now: number, stop?: (feed: TimedFeed) => void): LiveWork[] {
    return feeds.flatMap((feed) => {
        if (!sessionMidTurn(feed.transcript)) return [];
        const who = lookup(feed.agentId);
        const step = currentStep(feed.transcript);
        return [{ agentId: feed.agentId, name: who.name, hue: who.hue, startedAt: feed.turnStartedAt ?? now, ...(step ? { step } : {}), ...(stop ? { onStop: () => stop(feed) } : {}) }];
    });
}
