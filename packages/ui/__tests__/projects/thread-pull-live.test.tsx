/**
 * The live chat PR card (#935): a `pull_report` answer — read (the full record) or not yet (`{number, repo}`) — renders
 * the `PullCard` when the page gives `pullLinks.usePull`, and the card follows the page's Pulls store by repo and
 * number, so one card updates in place.
 */
import { describe, it, expect } from 'vitest';
import { component, signal, type Define } from '@sigx/runtime-core';
import { createTranscript } from '@sigx/ai-agent';
import type { PullRequest } from '@agentic/core';
import type { ToolPartState } from '@sigx/ai-agent/app';
import { Thread } from '../../src/thread';
import { pullRefOf, type PullLinksFn } from '../../src/thread/ToolCall';
import { mount, tick } from '../helpers';

const pr: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 602, title: 'shell: drawer collapses below 768 px', url: 'https://github.com/andtii/agentic/pull/602',
    head: 'drawer', base: 'main', state: 'open', additions: 40, deletions: 8, files: 3, openedBy: 'forge', openedAt: 1_000,
    checks: [{ name: 'test', state: 'running' }], review: { state: 'none', reviewers: [], threads: [] }
};

function transcriptWith(output: unknown, name = 'pull_report') {
    const transcript = createTranscript('s1');
    transcript.messages.push({ id: 'm1', role: 'assistant', parts: [{ type: 'tool', callId: 'c1', name, status: 'completed', input: { number: 602 }, output: JSON.stringify(output) }] });
    return transcript;
}

/** A fake Pulls store: the page's live read over a signal. */
function fakeStore(initial: readonly PullRequest[]) {
    const st = signal<{ pulls: readonly PullRequest[] }>({ pulls: initial });
    const refs: { repo?: string; number: number }[] = [];
    const links: PullLinksFn = Object.assign((p: PullRequest) => ({ href: `/projects/p/work/pr:${p.number}` }), {
        usePull: (ref: { repo?: string; number: number }) => {
            refs.push(ref);
            return () => st.pulls.find((p) => p.number === ref.number && (!ref.repo || p.repo === ref.repo));
        }
    });
    return { st, refs, links };
}

/** A page whose `pullLinks` arrives later (its project read lands after the first render). */
const Wrapper = component<Define.Prop<'transcript', ReturnType<typeof createTranscript>, true> & Define.Prop<'links', () => PullLinksFn | undefined, true>>(
    ({ props }) => () => <Thread transcript={props.transcript} pullLinks={props.links()} />
);

const card = (host: ParentNode) => host.querySelector('[data-ag-project="pull-card"]');

describe('pullRefOf', () => {
    const part = (name: string, output: unknown): ToolPartState => ({ type: 'tool', callId: 'c', name, status: 'completed', input: {}, output: JSON.stringify(output) }) as ToolPartState;
    it('names the PR of a full record or of a pull_report answer, not another tool’s number', () => {
        expect(pullRefOf(part('git_pr_create', pr))).toEqual({ repo: 'andtii/agentic', number: 602 });
        expect(pullRefOf(part('pull_report', { number: 7, repo: 'o/r', note: 'not read yet' }))).toEqual({ repo: 'o/r', number: 7 });
        expect(pullRefOf(part('pull_report', { number: 7, note: 'not watched' }))).toEqual({ number: 7 });
        expect(pullRefOf(part('other', { number: 7 }))).toBeUndefined();
    });
});

describe('the live chat PR card (#935)', () => {
    it('a pull_report answer not read yet renders the card once the store has the PR, and it updates in place', async () => {
        const store = fakeStore([]);
        const host = mount(<Thread transcript={transcriptWith({ number: 602, provider: 'github', repo: 'andtii/agentic', note: 'not read yet; it is read on the next poll' })} pullLinks={store.links} />);
        expect(card(host)).toBeNull();
        expect(host.textContent).toContain('not read yet');

        store.st.pulls = [pr];
        await tick();
        expect(card(host)?.getAttribute('data-state')).toBe('open');
        expect(store.refs).toEqual([{ repo: 'andtii/agentic', number: 602 }]);

        store.st.pulls = [{ ...pr, state: 'merged', checks: [{ name: 'test', state: 'passed' }] }];
        await tick();
        expect(host.querySelectorAll('[data-ag-project="pull-card"]')).toHaveLength(1);
        expect(card(host)?.getAttribute('data-state')).toBe('merged');
        // One live read, opened once.
        expect(store.refs).toHaveLength(1);
    });

    it('a read pull_report answer renders from the snapshot, then follows the store', async () => {
        const store = fakeStore([]);
        const host = mount(<Thread transcript={transcriptWith(pr)} pullLinks={store.links} />);
        expect(card(host)?.getAttribute('data-state')).toBe('open');
        expect(card(host)?.querySelector('a')?.getAttribute('href')).toBe('/projects/p/work/pr:602');
        store.st.pulls = [{ ...pr, title: 'renamed', state: 'closed' }];
        await tick();
        expect(card(host)?.getAttribute('data-state')).toBe('closed');
        expect(card(host)?.textContent).toContain('closed');
    });

    it('a live read that arrives after the first render takes over the card', async () => {
        const store = fakeStore([{ ...pr, state: 'merged' }]);
        const st = signal<{ links: PullLinksFn | undefined }>({ links: undefined });
        const transcript = transcriptWith(pr);
        const host = mount(<Wrapper transcript={transcript} links={() => st.links} />);
        expect(card(host)?.getAttribute('data-state')).toBe('open');
        st.links = store.links;
        await tick();
        expect(card(host)?.getAttribute('data-state')).toBe('merged');
    });

    it('without a live read, an unread pull_report answer stays the output well', () => {
        const host = mount(<Thread transcript={transcriptWith({ number: 602, repo: 'andtii/agentic', note: 'not read yet' })} />);
        expect(card(host)).toBeNull();
        expect(host.textContent).toContain('not read yet');
    });
});
