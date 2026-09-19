import { describe, expect, it } from 'vitest';
import { a2aPeer, a2aPeerId, a2aPeerIdFrom, a2aPeerRuntime, a2aPeerTokenSecret, isA2aPeerRuntime } from '../src/index';
import { fakeServer } from './fake';

describe('a2aPeer (#246)', () => {
    it('mints a runtime manifest a2a.<id> with its card URL as config, an optional token, and the permissions it uses', () => {
        const m = a2aPeer({ id: 'helper', name: 'Helper', cardUrl: 'https://peer.example.com/a2a/helper' });
        expect(m).toMatchObject({ id: 'a2a.helper', kind: 'runtime', name: 'Helper', capabilities: ['a2a-peer', 'remote'] });
        expect(m.config).toMatchObject({ required: ['cardUrl'], properties: { cardUrl: { type: 'string', format: 'uri', default: 'https://peer.example.com/a2a/helper' } } });
        expect(m.secrets).toEqual([expect.objectContaining({ name: 'a2a-helper-token', required: false })]);
        expect(m.permissions.map((p) => p.scope)).toEqual(['network:peer.example.com', 'secret:a2a-helper-token']);
        expect(a2aPeer({ id: 'x', cardUrl: 'http://localhost:8787/a2a/x' }).name).toBe('x');
    });

    it('refuses an id outside the alphabet and a URL that is not http(s)', () => {
        expect(() => a2aPeer({ id: 'a.b', cardUrl: 'https://p.example.com' })).toThrow(/peer id/);
        expect(() => a2aPeer({ id: '', cardUrl: 'https://p.example.com' })).toThrow(/peer id/);
        expect(() => a2aPeer({ id: 'ok', cardUrl: 'not a url' })).toThrow(/not a URL/);
        expect(() => a2aPeer({ id: 'ok', cardUrl: 'file:///etc/passwd' })).toThrow(/http\(s\)/);
    });

    it('names ids, tokens and runtimes consistently', () => {
        expect(a2aPeerTokenSecret('helper')).toBe('a2a-helper-token');
        expect(a2aPeerId('a2a.helper')).toBe('helper');
        expect(a2aPeerId('a2a.')).toBeUndefined();
        expect(a2aPeerId('anthropic-api')).toBeUndefined();
        expect(isA2aPeerRuntime('agentic.a2a.server')).toBe(false);
        expect(a2aPeerIdFrom('  Research Bot (EU) ')).toBe('research-bot-eu');
        expect(() => a2aPeerRuntime('anthropic-api')).toThrow(/not an A2A peer runtime/);
    });
});

describe('a2aPeerRuntime (#246)', () => {
    const plugin = (config: Record<string, unknown>, token?: string) => ({ config, secret: async (name: string) => (name === 'a2a-helper-token' ? token : undefined) });

    it('opens a session on the card in its config, with the token as the bearer, and the session answers', async () => {
        const auth: (string | null)[] = [];
        const server = fakeServer({ steps: [{ text: 'hi from the peer' }] });
        const runtime = a2aPeerRuntime('a2a.helper', { fetch: (r) => { auth.push(r.headers.get('authorization')); return server.fetch(r); } });
        const opened = await runtime.open({ signal: new AbortController().signal }, plugin({ cardUrl: server.cardUrl }, 'tok'));
        expect(opened.agentId).toBe('a2a.helper');
        let text = '';
        for await (const e of opened.session.prompt('hello')) if (e.type === 'part-delta') text += e.delta;
        expect(text).toBe('hi from the peer');
        expect(new Set(auth)).toEqual(new Set(['Bearer tok']));
        await opened.dispose();
    });

    it('fails the open, naming the plugin page, when the config has no card URL', async () => {
        await expect(a2aPeerRuntime('a2a.helper').open({ signal: new AbortController().signal }, plugin({}))).rejects.toThrow('/plugins/a2a.helper');
        // The schema's `uri` takes any scheme; the open refuses one that is not http(s) before any request.
        await expect(a2aPeerRuntime('a2a.helper').open({ signal: new AbortController().signal }, plugin({ cardUrl: 'ftp://peer.example.com/card' }))).rejects.toThrow('must be http(s)');
    });
});
