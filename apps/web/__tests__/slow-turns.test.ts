/**
 * The slow-turn log line (#492): what `wrangler tail` shows when an actor
 * turn ran or queued past the threshold, and nothing for a quick one.
 */
import { describe, expect, it } from 'vitest';
import { observeSlowTurns, slowTurnLine } from '../src/actors/slow-turns';
import type { Host } from '@sigx/actors';

type ActorTurnObserver = Parameters<Host['observeTurns']>[0];

const ref = { type: 'routing', key: 'u1:routing:main' };

describe('slowTurnLine', () => {
    it('reports a turn that ran past the threshold, and one that queued past it', () => {
        expect(slowTurnLine(ref, 'machineOnline', 12, 94_521, false)).toBe('[actors] slow turn: routing/u1:routing:main.machineOnline() ran 94521 ms');
        expect(slowTurnLine(ref, 'run', 30_004, 40, true)).toBe("[actors] slow turn: routing/u1:routing:main.run() ran 40 ms, queued 30004 ms behind the actor's other turns and threw");
        expect(slowTurnLine(ref, 'get', 2_000, 3_000, false)).toBe("[actors] slow turn: routing/u1:routing:main.get() ran 3000 ms, queued 2000 ms behind the actor's other turns");
    });

    it('says nothing for a quick turn', () => {
        expect(slowTurnLine(ref, 'get', 900, 4_000, false)).toBeUndefined();
        expect(slowTurnLine(ref, 'get', 0, 12, true)).toBeUndefined();
    });
});

describe('observeSlowTurns', () => {
    it('attaches one observer per host and logs only the slow turns through it', () => {
        const observers: ActorTurnObserver[] = [];
        const host = { observeTurns: (o: ActorTurnObserver) => (observers.push(o), () => undefined) } as unknown as Host;
        const lines: string[] = [];
        observeSlowTurns(host, (l) => lines.push(l));
        observeSlowTurns(host, (l) => lines.push(l));
        expect(observers).toHaveLength(1);
        observers[0]!(ref, 'get', 0, 5, false);
        observers[0]!(ref, 'forwardFrames', 0, 85_258, false);
        expect(lines).toEqual(['[actors] slow turn: routing/u1:routing:main.forwardFrames() ran 85258 ms']);
    });
});
