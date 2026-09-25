/**
 * The thread hands a page's `pullLinks` down to every tool call (#826): a call that returned a pull request carries a
 * `PullCard` that opens the page's PR page and diff, not the provider's URL.
 */
import { describe, it, expect } from 'vitest';
import { createTranscript } from '@sigx/ai-agent';
import type { PullRequest } from '@agentic/core';
import { Thread } from '../../src/thread';
import { mount } from '../helpers';

const pr: PullRequest = {
    provider: 'github', repo: 'andtii/agentic', number: 602, title: 'shell: drawer collapses below 768 px', url: 'https://github.com/andtii/agentic/pull/602',
    head: 'drawer', base: 'main', state: 'open', additions: 40, deletions: 8, files: 3, openedBy: 'forge', openedAt: 1_000,
    checks: [{ name: 'test', state: 'passed' }], review: { state: 'approved', reviewers: ['Lint'], threads: [] }, mergeable: true
};

function transcriptWithPull() {
    const transcript = createTranscript('s1');
    transcript.messages.push({ id: 'm1', role: 'assistant', parts: [{ type: 'tool', callId: 'c1', name: 'git_pr_create', status: 'completed', input: { title: 'x' }, output: JSON.stringify(pr) }] });
    return transcript;
}

const hrefs = (host: ParentNode): string[] => [...host.querySelectorAll('[data-ag-project="pull-card"] a')].map((a) => a.getAttribute('href') ?? '');

describe('Thread → pullLinks', () => {
    it('the chat card opens the PR page and its diff the page names', () => {
        const host = mount(<Thread transcript={transcriptWithPull()} pullLinks={(p) => ({ href: `/projects/p/work/pr:${p.number}`, diffHref: `${p.url}/files` })} />);
        expect(hrefs(host)).toContain('/projects/p/work/pr:602');
        expect(hrefs(host)).toContain('https://github.com/andtii/agentic/pull/602/files');
        expect(hrefs(host)).not.toContain(pr.url);
    });

    it('without pullLinks the card keeps the provider URL', () => {
        const host = mount(<Thread transcript={transcriptWithPull()} />);
        expect(hrefs(host)).toContain(pr.url);
    });
});
