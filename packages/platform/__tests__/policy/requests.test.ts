/** The request / grant views over a session log (`policy/requests.ts`, #40) and the inbox ref match. */
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@sigx/ai-agent';

import { sameRef } from '../../src/notify/index';
import { describeRule, parseRequestRef, permissionKeyOf, requestRecordOf, requestRecordsOf, requestRef, sessionGrantsOf } from '../../src/policy/index';

const stamp = (seq: number) => ({ sessionId: 's', epoch: 1, seq, turnId: 't1' });
const call = (callId: string, name: string, seq: number): AgentEvent => ({ ...stamp(seq), type: 'tool-call', callId, name, input: { n: seq }, category: 'destructive', annotations: { destructive: true } });
const request = (requestId: string, callId: string, seq: number, permissionKey?: string): AgentEvent => ({ ...stamp(seq), type: 'request', requestId, kind: 'permission', callId, toolName: 'rm', ...(permissionKey ? { permissionKey } : {}) });
const resolved = (requestId: string, seq: number, scope: 'once' | 'session', by: 'client' | 'policy' = 'client'): AgentEvent => ({ ...stamp(seq), type: 'request-resolved', requestId, outcome: 'allow', scope, by, at: seq * 10 });

describe('request records', () => {
    it('joins a request with its call and its decision, and lists open ones', () => {
        const events = [call('c1', 'rm', 1), request('r1', 'c1', 2), call('c2', 'rm', 3), request('r2', 'c2', 4), resolved('r1', 5, 'once')];
        expect(requestRecordOf(events, 'r1')).toMatchObject({ request: { requestId: 'r1' }, input: { n: 1 }, category: 'destructive', annotations: { destructive: true }, resolved: { requestId: 'r1', outcome: 'allow' } });
        expect(requestRecordOf(events, 'r2')!.resolved).toBeUndefined();
        expect(requestRecordOf(events, 'nope')).toBeNull();
        expect(requestRecordsOf(events).map((r) => r.request.requestId)).toEqual(['r1', 'r2']);
    });

    it('refs pair a request with its resolution and parse back; anything else is null', () => {
        expect(requestRef({ kind: 'permission', requestId: 'r1' })).toBe('approval:r1');
        expect(requestRef({ kind: 'input', requestId: 'r2' })).toBe('input:r2');
        expect(parseRequestRef('approval:r1')).toEqual({ need: 'approval', requestId: 'r1' });
        expect(parseRequestRef('input:r_2:x')).toEqual({ need: 'input', requestId: 'r_2:x' });
        expect(parseRequestRef('interrupted:t1')).toBeNull();
        expect(parseRequestRef('approval:')).toBeNull();
        expect(parseRequestRef(undefined)).toBeNull();
    });
});

describe('session grants', () => {
    it('lists session-scoped allows by permission key (the adapter’s, else tool:<name>), the latest per key, never a once', () => {
        const events = [request('r1', 'c1', 1, 'rm:a'), resolved('r1', 2, 'session'), request('r2', 'c2', 3), resolved('r2', 4, 'once'), request('r3', 'c3', 5), resolved('r3', 6, 'session', 'policy'), request('r4', 'c4', 7, 'rm:a'), resolved('r4', 8, 'session')];
        expect(permissionKeyOf({ toolName: 'rm' })).toBe('tool:rm');
        expect(permissionKeyOf({ permissionKey: 'k', toolName: 'rm' })).toBe('k');
        expect(sessionGrantsOf(events)).toEqual([
            { permissionKey: 'tool:rm', toolName: 'rm', requestId: 'r3', by: 'policy', at: 60 },
            { permissionKey: 'rm:a', toolName: 'rm', requestId: 'r4', by: 'client', at: 80 }
        ]);
        expect(sessionGrantsOf([])).toEqual([]);
    });
});

describe('describeRule', () => {
    it('names a rule the way the card does', () => {
        expect(describeRule({ id: 'a', match: { categories: ['destructive'] }, outcome: 'ask' })).toBe('ask on destructive');
        expect(describeRule({ id: 'b', match: { tools: ['Bash', 'Edit'] }, outcome: 'deny' })).toBe('deny Bash, Edit');
        expect(describeRule({ id: 'c', match: { source: 'mcp' }, outcome: 'allow', scope: 'session' })).toBe('allow mcp tools for session');
        expect(describeRule({ id: 'd', match: {}, outcome: 'ask' })).toBe('ask everything');
    });
});

describe('sameRef', () => {
    it('matches every field of the wanted ref; a ref without a request id matches the whole session', () => {
        expect(sameRef({ kind: 'session', sessionId: 's' as never, requestId: 'r' }, { kind: 'session', sessionId: 's' as never, requestId: 'r' })).toBe(true);
        expect(sameRef({ kind: 'session', sessionId: 's' as never, requestId: 'r' }, { kind: 'session', sessionId: 's' as never })).toBe(true);
        expect(sameRef({ kind: 'session', sessionId: 's' as never, requestId: 'r' }, { kind: 'session', sessionId: 's' as never, requestId: 'q' })).toBe(false);
        expect(sameRef({ kind: 'task', taskId: 't' as never }, { kind: 'session', sessionId: 's' as never })).toBe(false);
    });
});
