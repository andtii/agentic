/**
 * #870: host rows placed in the thread by time (`placeInserts`, `Thread.inserts`), and a visiting manager's project
 * chip and role on its message rows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTranscript } from '@sigx/ai-agent';
import type { AgentMessage } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import { Message, Thread, aiMessageAnatomy, isoTime, placeInserts, type MessageAuthor, type ThreadInsert } from '../src/thread';
import { all, mount, one, unmountAll } from './helpers';

afterEach(unmountAll);

const msg = (id: string, text = id): AgentMessage => ({ id, role: 'assistant', parts: [{ type: 'text', id: `${id}:0`, text }] });
const at = (key: string, t: number) => ({ key, at: t });

describe('placeInserts', () => {
    const messages = [msg('a'), msg('b'), msg('c')];
    const times: Record<string, number> = { a: 10, b: 20, c: 30 };

    it('puts each insert before the first message later than it, and the latest after every message', () => {
        const p = placeInserts(messages, [at('late', 35), at('mid', 15), at('early', 5)], (m) => times[m.id]);
        expect(p.before.get('a')?.map((i) => i.key)).toEqual(['early']);
        expect(p.before.get('b')?.map((i) => i.key)).toEqual(['mid']);
        expect(p.before.has('c')).toBe(false);
        expect(p.after.map((i) => i.key)).toEqual(['late']);
    });

    it('keeps a message at the same instant ahead of the insert, and inserts at one instant in the given order', () => {
        const p = placeInserts(messages, [at('x', 20), at('y', 20)], (m) => times[m.id]);
        expect(p.before.get('c')?.map((i) => i.key)).toEqual(['x', 'y']);
    });

    it('treats a message with no time as later than every insert: the inserts land before it', () => {
        const p = placeInserts([msg('a'), msg('live')], [at('r', 50)], (m) => (m.id === 'a' ? 10 : undefined));
        expect(p.before.get('live')?.map((i) => i.key)).toEqual(['r']);
        expect(p.after).toEqual([]);
    });

    it('with no times at all keeps every insert after the thread', () => {
        const p = placeInserts(messages, [at('r', 1)], () => undefined);
        expect(p.before.size).toBe(0);
        expect(p.after.map((i) => i.key)).toEqual(['r']);
    });

    it('reads an ISO dateTime, and nothing from a missing or broken one', () => {
        expect(isoTime('1970-01-01T00:00:01.000Z')).toBe(1000);
        expect(isoTime(undefined)).toBeUndefined();
        expect(isoTime('not a date')).toBeUndefined();
    });
});

describe('Thread inserts', () => {
    const iso = (t: number) => new Date(t).toISOString();
    const authors: Record<string, MessageAuthor> = {
        a: { name: 'Forge', time: { text: 'a', dateTime: iso(1000) } },
        b: { name: 'Nova', time: { text: 'b', dateTime: iso(3000) } }
    };
    const card = (key: string, t: number): ThreadInsert => ({ key, at: t, render: () => <p data-card={key}>{key}</p> });

    const rowKinds = (dom: HTMLElement) => all(dom, 'ai-thread', 'row').map((li) => li.querySelector('[data-card]')?.getAttribute('data-card') ?? li.textContent?.trim());

    it('draws each insert between the messages it happened between', () => {
        const transcript = createTranscript('t');
        transcript.messages = [msg('a', 'first'), msg('b', 'second')];
        const dom = mount(<Thread transcript={transcript} describe={(m) => authors[m.id]} inserts={[card('result', 4000), card('request', 2000)]} />);
        const kinds = rowKinds(dom);
        expect(kinds[1]).toBe('request');
        expect(kinds[3]).toBe('result');
        expect(kinds.length).toBe(4);
        expect(kinds[0]).toContain('first');
        expect(kinds[2]).toContain('second');
        expect(all(dom, 'ai-thread', 'row')[1]!.hasAttribute('data-insert')).toBe(true);
    });

    it('leaves out an insert whose message is windowed away', () => {
        const transcript = createTranscript('t');
        transcript.messages = [msg('a', 'first'), msg('b', 'second')];
        const dom = mount(<Thread transcript={transcript} window={1} describe={(m) => authors[m.id]} inserts={[card('old', 500), card('request', 2000)]} />);
        expect(dom.querySelector('[data-card="old"]')).toBeNull();
        expect(dom.querySelector('[data-card="request"]')).not.toBeNull();
    });
});

describe('a visiting author on a message row', () => {
    it('carries its project chip and role after the name', () => {
        const dom = mount(<Message message={msg('m')} author={{ name: 'Nova', project: 'SignalX', role: 'project manager, visiting' }} />);
        expect(one(dom, 'ai-message', 'project')!.textContent).toBe('SignalX');
        expect(one(dom, 'ai-message', 'project')!.querySelector('svg')).not.toBeNull();
        expect(one(dom, 'ai-message', 'role')!.textContent).toBe('project manager, visiting');
        expectAnatomy(dom, aiMessageAnatomy);
    });

    it('has neither without them', () => {
        const dom = mount(<Message message={msg('m')} author={{ name: 'Forge', project: ' ' }} />);
        expect(one(dom, 'ai-message', 'project')).toBeNull();
        expect(one(dom, 'ai-message', 'role')).toBeNull();
    });
});
