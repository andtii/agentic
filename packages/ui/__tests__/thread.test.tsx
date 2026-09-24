/**
 * The thread over a real session: `mockAgent` streams through
 * `useAgentSession`, the reducer folds in place, and the thread windows what
 * it shows. Nothing here is mocked below the session contract.
 */
import { describe, it, expect } from 'vitest';
import { component } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
import { allowAll, createTranscript, type Agent } from '@sigx/ai-agent';
import { useAgentSession, type AgentMessage, type AgentSessionView, type AgentTranscript, type Decision } from '@sigx/ai-agent/app';
import { mockAgent, type MockStep } from '@sigx/ai-agent/testing';
import { expectAnatomy } from '@sigx/zero/testing';
import { Thread, aiThreadAnatomy, aiMessageAnatomy, aiToolCallAnatomy, DEFAULT_WINDOW } from '../src/thread';
import { mount, one, all, buttonNamed, tick, waitFor, unmountAll } from './helpers';

/** Mount a thread on a live session; hand the view back so the test can drive it. */
async function live(agent: Agent, opts: { policy?: boolean; window?: number } = {}): Promise<{ dom: HTMLDivElement; view: AgentSessionView }> {
    const session = await agent.session(opts.policy === false ? {} : { policy: allowAll });
    let view!: AgentSessionView;
    const Harness = component(() => {
        view = useAgentSession(session);
        return () => <Thread transcript={view.transcript} window={opts.window} onRespond={(id, d) => void view.respond(id, d)} />;
    }, { name: 'Harness' });
    const dom = mount(<Harness />);
    await tick();
    return { dom, view };
}

const rows = (dom: ParentNode) => all(dom, 'ai-thread', 'row');
/** Every rendered part element: a rich-text root per text part, a card per tool part, a block per reasoning part. */
const parts = (dom: ParentNode) => dom.querySelectorAll('[data-scope="ai-message"] [data-scope="richtext"][data-part="root"], [data-scope="ai-tool-call"][data-part="root"], [data-scope="ai-reasoning"][data-part="root"]');

/** A scripted turn of `n` parts — text and tool calls alternating. */
function manyParts(n: number, label = 'part'): MockStep[] {
    return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? { text: `${label} ${i}` } : { tool: { name: 'read', input: { i }, output: `out ${i}` } }));
}

/** Scroll geometry happy-dom does not compute: pin it, then scroll. */
function scrollTo(el: HTMLElement, top: number, geometry = { scrollHeight: 4000, clientHeight: 600 }): void {
    Object.defineProperty(el, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: geometry.clientHeight, configurable: true });
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
}

describe('the thread over mockAgent', () => {
    it('streaming 2 000 parts keeps under 200 DOM rows, and the parts in the DOM within the window', async () => {
        const agent = mockAgent({ script: [manyParts(2000)] });
        const { dom, view } = await live(agent);
        await view.prompt('go');
        await tick();
        // The whole turn folded: the user's message plus one assistant message of 2 000 parts.
        expect(view.transcript.messages.reduce((n, m) => n + m.parts.length, 0)).toBe(2001);
        expect(rows(dom).length).toBeLessThan(200);
        expect(parts(dom).length).toBeLessThanOrEqual(DEFAULT_WINDOW);
        expect(parts(dom).length).toBeGreaterThan(100);
        // The tail is what shows.
        expect(dom.textContent).toContain('part 1998');
        expect(dom.textContent).not.toContain('part 0');
        expect(one(dom, 'ai-message', 'footer')!.textContent).toBe(`parts ${2000 - DEFAULT_WINDOW + 1}–2000 of 2000`);
        expectAnatomy(dom, aiThreadAnatomy);
        expectAnatomy(dom, aiMessageAnatomy);
        expectAnatomy(dom, aiToolCallAnatomy);
        // 2 000 re-renders of a 150-part window under happy-dom: seconds, not the 5 s default.
    }, 60_000);

    it('attributes every row: the user at the end as a person, the assistant at the start as an agent tile, name per author', async () => {
        const agent = mockAgent({ script: [[{ text: 'hello', actor: 'triage' }]] });
        const { dom, view } = await live(agent);
        await view.prompt('hi');
        await tick();
        const roots = all(dom, 'ai-message', 'root');
        expect(roots.map((r) => r.getAttribute('data-placement'))).toEqual(['end', 'start']);
        expect(all(dom, 'ai-message', 'name').map((m) => m.textContent)).toEqual(['You', 'triage']);
        const tiles = all(dom, 'ag-agent-tile', 'root');
        expect(tiles.map((t) => t.hasAttribute('data-mod-circle'))).toEqual([true, false]);
        // Nothing streams once the turn ended, and nobody described the rows: no env line, no time.
        expect(one(dom, 'ai-message', 'environment')).toBeNull();
        expect(dom.querySelector('[data-scope="ag-pill"][data-status="streaming"]')).toBeNull();
    });

    it('pauses on scroll-up — the window freezes while the agent streams on — and the anchor resumes the tail', async () => {
        const agent = mockAgent({ script: [manyParts(400), manyParts(400, 'later')] });
        const { dom, view } = await live(agent, { window: 50 });
        await view.prompt('one');
        await tick();
        const root = one(dom, 'ai-thread', 'root')!;
        expect(root.getAttribute('data-state')).toBe('on');
        expect(one(dom, 'ai-thread', 'anchor')!.hidden).toBe(true);
        const before = dom.textContent;

        scrollTo(root, 3400);
        scrollTo(root, 100);
        await tick();
        expect(root.getAttribute('data-state')).toBe('off');
        expect(one(dom, 'ai-thread', 'anchor')!.hidden).toBe(false);

        await view.prompt('two');
        await tick();
        // Nothing moved under the reader.
        expect(dom.textContent).toBe(before);
        expect(dom.textContent).not.toContain('later');
        expect(parts(dom).length).toBeLessThanOrEqual(50);

        buttonNamed(dom, 'Jump to latest').click();
        await tick();
        expect(root.getAttribute('data-state')).toBe('on');
        expect(dom.textContent).not.toBe(before);
        expect(dom.textContent).toContain('later 398');
        expect(rows(dom).length).toBeLessThanOrEqual(50);
    });

    it('scrolling back to the bottom follows again', async () => {
        const agent = mockAgent({ script: [manyParts(100)] });
        const { dom, view } = await live(agent, { window: 20 });
        await view.prompt('go');
        await tick();
        const root = one(dom, 'ai-thread', 'root')!;
        scrollTo(root, 3400);
        scrollTo(root, 0);
        await tick();
        expect(root.getAttribute('data-state')).toBe('off');
        scrollTo(root, 3400);
        await tick();
        expect(root.getAttribute('data-state')).toBe('on');
    });

    it('"Show earlier" widens the window backwards, one window at a time', async () => {
        const agent = mockAgent({ script: [manyParts(100)] });
        const { dom, view } = await live(agent, { window: 20 });
        await view.prompt('go');
        await tick();
        expect(parts(dom)).toHaveLength(20);
        const earlier = one(dom, 'ai-thread', 'earlier')!;
        expect(earlier.textContent).toBe('Showing the last 20 entries·Load earlier');
        earlier.click();
        await tick();
        expect(parts(dom)).toHaveLength(40);
        expect(one(dom, 'ai-thread', 'earlier')!.textContent).toContain('Showing the last 40 entries');
        expect(dom.textContent).toContain('part 60');
    });

    it('with `hasEarlier` the chip stays once the window is fully open and reaching the top asks the host; prepended rows keep the frozen rows in place (#398)', async () => {
        const rowsFrom = (from: number, n: number): AgentMessage[] => Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, role: 'user' as const, parts: [{ type: 'text' as const, id: `p${from + i}`, text: `row ${from + i}` }] }));
        const transcript = signal(createTranscript('s1'));
        transcript.messages = rowsFrom(100, 30);
        const asked: number[] = [];
        const dom = mount(<Thread transcript={transcript} window={20} hasEarlier onEarlier={() => asked.push(transcript.messages.length)} />);
        const chip = (): HTMLElement => one(dom, 'ai-thread', 'earlier')!;
        const shown = (): string[] => rows(dom).map((r) => one(r, 'ai-message', 'body')!.textContent!.trim());
        // Windowed: the chip widens the window first, asking nothing.
        expect(chip().textContent).toBe('Showing the last 20 entries·Load earlier');
        chip().click();
        await tick();
        expect(rows(dom)).toHaveLength(30);
        expect(asked).toEqual([]);
        // Fully open: the chip stays, and asks the host.
        expect(chip().textContent).toBe('Showing the last 30 entries·Load earlier');
        chip().click();
        await tick();
        expect(asked).toEqual([30]);
        // Scrolled to the top: frozen, and asked once — not again on the next tick at the top.
        const root = one(dom, 'ai-thread', 'root')!;
        scrollTo(root, 3400);
        scrollTo(root, 0);
        scrollTo(root, 0);
        await tick();
        expect(root.getAttribute('data-state')).toBe('off');
        expect(asked).toEqual([30, 30]);
        const before = shown();
        expect(before[0]).toBe('row 100');
        // The host prepends: the rows in view stay, the new ones precede them, and the top is re-armed.
        transcript.messages = [...rowsFrom(80, 20), ...transcript.messages];
        await tick();
        const after = shown();
        expect(after.slice(-before.length)).toEqual(before);
        expect(after[0]).toBe('row 90');
        expect(after).toHaveLength(40);
        // Reaching the top again widens onto the ten rows still windowed away, then asks the host once more.
        scrollTo(root, 0);
        await tick();
        expect(asked).toEqual([30, 30]);
        expect(shown()).toHaveLength(50);
        expect(shown()[0]).toBe('row 80');
        scrollTo(root, 0);
        await tick();
        expect(asked).toEqual([30, 30, 50]);
        // Scrolling away and back asks again; a scroll that stays away asks nothing.
        scrollTo(root, 500);
        scrollTo(root, 600);
        await tick();
        expect(asked).toEqual([30, 30, 50]);
        scrollTo(root, 0);
        await tick();
        expect(asked).toEqual([30, 30, 50, 50]);
    });

    it('renders the approval prompt on the waiting card, and the chosen scope lands as a session grant', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'write', input: { path: 'a.txt' }, output: 'ok' } }, { text: 'done' }]] });
        const { dom, view } = await live(agent, { policy: false });
        const turn = view.prompt('go');
        await waitFor(() => view.requests.length === 1);
        await tick();
        const card = one(dom, 'ai-tool-call', 'root')!;
        expect(card.getAttribute('data-state')).toBe('loading');
        expect(one(card, 'ai-tool-call', 'status')!.textContent).toBe('PENDING');
        expect(one(card, 'ai-tool-call', 'meta')!.textContent).toBe('awaiting approval');
        expect(one(card, 'ai-approval', 'root')).not.toBeNull();
        // Mid-turn: the assistant row carries the STREAMING pill.
        expect(dom.querySelector('[data-scope="ag-pill"][data-status="streaming"]')).not.toBeNull();

        buttonNamed(card, 'Allow for this session').click();
        await turn;
        await tick();
        expect(view.transcript.grants).toContain('tool:write');
        expect(one(dom, 'ai-approval', 'root')).toBeNull();
        expect(one(dom, 'ai-tool-call', 'root')!.getAttribute('data-state')).toBe('complete');
        expect(dom.textContent).toContain('done');
    });

    it('a denied call reads as denied, with the reason on the card', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'rm', output: 'gone' } }, { text: 'after' }]] });
        const { dom, view } = await live(agent, { policy: false });
        const turn = view.prompt('go');
        await waitFor(() => view.requests.length === 1);
        await tick();
        buttonNamed(dom, 'Deny').click();
        await turn;
        await tick();
        expect(one(dom, 'ai-tool-call', 'root')!.getAttribute('data-state')).toBe('denied');
        expect(one(dom, 'ai-tool-call', 'status')!.textContent).toBe('DENIED');
        expect(one(dom, 'ai-tool-call', 'error')!.textContent).toBe('The operator denied this call.');
    });
});

describe('the thread over a static transcript', () => {
    it('renders an empty log with no rows and the anchor hidden', () => {
        const transcript: AgentTranscript = createTranscript('s1');
        const seen: [string, Decision][] = [];
        const dom = mount(<Thread transcript={transcript} onRespond={(id, d) => seen.push([id, d])} label="Chat with triage" />);
        const root = one(dom, 'ai-thread', 'root')!;
        expect(root.getAttribute('role')).toBe('log');
        expect(root.getAttribute('aria-label')).toBe('Chat with triage');
        expect(rows(dom)).toHaveLength(0);
        expect(one(dom, 'ai-thread', 'earlier')).toBeNull();
        expectAnatomy(dom, aiThreadAnatomy);
    });

    it('a permission request with no call of its own gets a row at the end', () => {
        const transcript = createTranscript('s1');
        transcript.messages.push({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] });
        transcript.requests['r9'] = { requestId: 'r9', kind: 'permission', toolName: 'deploy', seq: 4 };
        const seen: [string, Decision][] = [];
        const dom = mount(<Thread transcript={transcript} onRespond={(id, d) => seen.push([id, d])} />);
        expect(rows(dom)).toHaveLength(2);
        buttonNamed(dom, 'Deny').click();
        expect(seen).toEqual([['r9', { type: 'permission', outcome: 'deny', scope: 'once', message: 'The operator denied this call.' }]]);
    });

    it('describes each row through the page — hue, environment, time — and pins STREAMING on the last assistant row mid-turn', () => {
        const transcript = createTranscript('s1');
        transcript.messages.push({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] });
        transcript.messages.push({ id: 'm2', role: 'assistant', actor: 'Forge', parts: [{ type: 'text', id: 'p1', text: 'on it' }] });
        transcript.messages.push({ id: 'm3', role: 'assistant', actor: 'Lint', parts: [{ type: 'text', id: 'p2', text: 'reading' }] });
        transcript.state = 'running';
        const dom = mount(
            <Thread
                transcript={transcript}
                describe={(m) => (m.role === 'user' ? { name: 'Andii', time: { text: '14:02' } } : { hue: m.actor === 'Forge' ? 2 : 3, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, time: { text: '14:09', dateTime: '2026-09-17T14:09:00Z' } })}
            />
        );
        expect(all(dom, 'ai-message', 'name').map((n) => n.textContent)).toEqual(['Andii', 'Forge', 'Lint']);
        expect(all(dom, 'ai-message', 'environment')).toHaveLength(2);
        expect(all(dom, 'ai-message', 'time').map((t) => t.textContent)).toEqual(['14:02', '14:09', '14:09']);
        expect(all(dom, 'ai-message', 'time')[1]!.getAttribute('datetime')).toBe('2026-09-17T14:09:00Z');
        expect(all(dom, 'ag-agent-tile', 'root').map((t) => t.getAttribute('data-hue'))).toEqual([null, '2', '3']);
        const streaming = all(dom, 'ai-message', 'root').map((r) => r.querySelector('[data-scope="ag-pill"][data-status="streaming"]') !== null);
        expect(streaming).toEqual([false, false, true]);
        expect(one(dom, 'ai-thread', 'root')!.getAttribute('aria-live')).toBe('polite');
        expectAnatomy(dom, aiMessageAnatomy);
    });
});

describe('following the tail (#495)', () => {
    const rowsOf = (n: number): AgentMessage[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'user' as const, parts: [{ type: 'text' as const, id: `p${i}`, text: `row ${i}` }] }));

    it('opens at the latest rows: the mount pins the bottom', () => {
        const proto = HTMLElement.prototype;
        const own = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
        Object.defineProperty(proto, 'scrollHeight', { get: () => 4000, configurable: true });
        try {
            const transcript = createTranscript('s1');
            transcript.messages = rowsOf(30);
            const dom = mount(<Thread transcript={transcript} />);
            const root = one(dom, 'ai-thread', 'root')!;
            expect(root.scrollTop).toBe(4000);
            expect(root.getAttribute('data-state')).toBe('on');
        } finally {
            if (own) Object.defineProperty(proto, 'scrollHeight', own);
            else delete (proto as { scrollHeight?: number }).scrollHeight;
        }
    });

    it('a scroll that moves down — a pin or content growing under it — keeps following, whatever the gap', async () => {
        const transcript = createTranscript('s1');
        transcript.messages = rowsOf(30);
        const dom = mount(<Thread transcript={transcript} />);
        const root = one(dom, 'ai-thread', 'root')!;
        scrollTo(root, 1000);
        scrollTo(root, 2000);
        await tick();
        expect(root.getAttribute('data-state')).toBe('on');
        expect(one(dom, 'ai-thread', 'anchor')!.hidden).toBe(true);
        // Only a move up past the threshold pauses.
        scrollTo(root, 1500);
        await tick();
        expect(root.getAttribute('data-state')).toBe('off');
        expect(one(dom, 'ai-thread', 'anchor')!.hidden).toBe(false);
    });

    it('content that grows without a thread render (a streaming part, an image) is pinned while following, left alone while paused', async () => {
        const observers: { cb: () => void; targets: Element[]; live: boolean }[] = [];
        const original = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
            private o: { cb: () => void; targets: Element[]; live: boolean };
            constructor(cb: () => void) { this.o = { cb, targets: [], live: true }; observers.push(this.o); }
            observe(el: Element): void { this.o.targets.push(el); }
            unobserve(): void {}
            disconnect(): void { this.o.live = false; }
        } as unknown as typeof ResizeObserver;
        try {
            const transcript = createTranscript('s1');
            transcript.messages = rowsOf(30);
            const dom = mount(<Thread transcript={transcript} />);
            const root = one(dom, 'ai-thread', 'root')!;
            const list = one(dom, 'ai-thread', 'list')!;
            const observer = observers.find((o) => o.targets.includes(list))!;
            expect(observer).toBeDefined();
            scrollTo(root, 3400);
            await tick();
            // The content grew by 1 000 px: the observer pins the new bottom.
            Object.defineProperty(root, 'scrollHeight', { value: 5000, configurable: true });
            observer.cb();
            expect(root.scrollTop).toBe(5000);
            // Paused: growth leaves the reader where they are.
            scrollTo(root, 1000, { scrollHeight: 5000, clientHeight: 600 });
            await tick();
            expect(root.getAttribute('data-state')).toBe('off');
            Object.defineProperty(root, 'scrollHeight', { value: 6000, configurable: true });
            observer.cb();
            expect(root.scrollTop).toBe(1000);
            unmountAll();
            expect(observer.live).toBe(false);
        } finally {
            globalThis.ResizeObserver = original;
        }
    });
});
