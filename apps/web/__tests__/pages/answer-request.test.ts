/** Answering a request from the chat (#454): an approved plan leaves plan mode for the member, a kept one changes nothing. */
import { describe, expect, it } from 'vitest';
import { answerRequest, type AnswerPorts } from '../../src/pages/chat/live';

function ports(): AnswerPorts & { readonly calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
        calls,
        respond: async (...a) => void calls.push(['respond', ...a]),
        setOptions: async (...a) => void calls.push(['setOptions', ...a]),
        configure: async (...a) => void calls.push(['configure', ...a])
    };
}

describe('answerRequest (#454)', () => {
    it('an approved plan: the answer first, then the member’s mode for this chat, then the running session', async () => {
        const p = ports();
        const allow = { type: 'permission', outcome: 'allow', scope: 'once' } as const;
        await answerRequest(p, 'agent_cc', 'r1', allow, { permissionMode: 'acceptEdits' });
        expect(p.calls).toEqual([
            ['respond', 'r1', allow],
            ['setOptions', 'agent_cc', { permissionMode: 'acceptEdits' }],
            ['configure', { permissionMode: 'acceptEdits' }]
        ]);
    });

    it('"Keep planning" and a plain approval only answer', async () => {
        const p = ports();
        await answerRequest(p, 'agent_cc', 'r1', { type: 'permission', outcome: 'deny', scope: 'once', message: 'revise' }, undefined);
        await answerRequest(p, 'agent_cc', 'r2', { type: 'permission', outcome: 'allow', scope: 'session' });
        expect(p.calls.map((c) => c[0])).toEqual(['respond', 'respond']);
    });

    it('a failed answer changes no mode', async () => {
        const p = { ...ports(), respond: async () => Promise.reject(new Error('closed')) };
        await expect(answerRequest(p, 'agent_cc', 'r1', { type: 'permission', outcome: 'allow', scope: 'once' }, { permissionMode: 'default' })).rejects.toThrow('closed');
        expect(p.calls).toEqual([]);
    });
});
