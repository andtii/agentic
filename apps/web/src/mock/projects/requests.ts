/**
 * Mock data for the Requests inbox (#722) — owned by #761, imported only by its own page and its test; nothing shared
 * re-exports it. The `Requests` board's batch: four incoming requests to `agentic` (one needs you, one the manager is
 * still triaging, one waiting on the sender, one accepted), nothing sent, and four linked items.
 */
import type { AgentId, ChatId, ProjectId, ProjectRequest } from '@agentic/core';
import type { RequestEntry } from '../../pages/projects/requests/model';
import { MOCK_NOW } from '../workspace';

const minutesAgo = (m: number): number => MOCK_NOW - m * 60_000;
const hoursAgo = (h: number): number => minutesAgo(h * 60);
const daysAgo = (d: number): number => hoursAgo(d * 24);
const agent = (id: string) => ({ kind: 'agent' as const, agentId: id as AgentId });
const to = 'p_agentic' as ProjectId;

const request = (r: Omit<ProjectRequest, 'toProject' | 'updatedAt' | 'refs'> & Partial<Pick<ProjectRequest, 'refs'>>): ProjectRequest => ({
    toProject: to,
    refs: [],
    updatedAt: r.createdAt,
    ...r
});

/** The phases of `agentic`'s plan a proposed item can go in (the Edit-first form's choices). */
export const MOCK_REQUEST_PHASES: Readonly<Record<string, readonly { n: number; title: string }[]>> = {
    p_agentic: [{ n: 1, title: 'Core fixes' }, { n: 2, title: 'Usage and quotas' }, { n: 3, title: 'Release 0.5' }]
};

/** The highest item number each project's plan holds: an accepted request becomes the next one. */
export const MOCK_REQUEST_ITEM_FLOOR: Readonly<Record<string, number>> = { p_agentic: 13 };

export const MOCK_REQUESTS: Readonly<Record<string, readonly RequestEntry[]>> = {
    p_agentic: [
        {
            box: 'incoming',
            fromProjectName: 'signalx',
            toProjectName: 'agentic',
            fromChatTitle: 'Usage rings on the member card',
            byYou: true,
            triagedAt: minutesAgo(2),
            area: 'core',
            request: request({
                id: 'req_7c2a',
                fromProject: 'p_signalx' as ProjectId,
                fromChat: 'c_rings' as ChatId,
                sender: agent('forge'),
                title: 'batch() drops updates when an effect throws',
                body: 'While fixing the size-limit check on #603, batch() swallowed two updates when an effect inside it threw. Repro test below. signalx 0.5 needs a fix.',
                refs: [
                    { kind: 'file', path: 'packages/ui/src/usage.test.ts', from: 12, to: 40 },
                    { kind: 'doc', path: 'stack-trace.txt' },
                    { kind: 'project-item', project: 'signalx', n: 16 }
                ],
                state: 'needs-you',
                triage: {
                    kind: 'bug',
                    priority: 'high',
                    priorityNote: 'blocks a release in another project',
                    reproduced: { ok: true, note: 'Forge’s test fails on agentic main b81e0d2' },
                    similar: [{ ref: { kind: 'item', n: 9 }, note: 'closed, nested batch; different cause' }],
                    proposedItem: {
                        title: 'batch() keeps pending updates when an effect throws',
                        phase: 1,
                        assignee: agent('forge'),
                        doneWhen: ['repro passes', 'bench holds'],
                        first: true
                    },
                    openIssue: true,
                    reply: 'Filed as agentic#14, high, Forge first in line. signalx#16 now waits on it, and I’ll post in this chat when it merges.',
                    why: 'high priority moves this week’s plan'
                },
                createdAt: minutesAgo(25)
            })
        },
        {
            box: 'incoming',
            fromProjectName: 'zero-wip',
            toProjectName: 'agentic',
            request: request({
                id: 'req_5e19',
                fromProject: 'p_zero' as ProjectId,
                sender: agent('lint'),
                title: 'Export the Signal type from the root entry',
                body: 'zero re-declares Signal because the root entry does not export it. Could the type come from the root?',
                state: 'triaging',
                createdAt: minutesAgo(6)
            })
        },
        {
            box: 'incoming',
            fromProjectName: 'signalx',
            toProjectName: 'agentic',
            note: 'Atlas asked which page',
            request: request({
                id: 'req_3b07',
                fromProject: 'p_signalx' as ProjectId,
                sender: { kind: 'user', userId: 'me' },
                title: 'computed() docs show the old API',
                body: 'The computed() page still shows the two-argument form.',
                state: 'asked-for-more',
                createdAt: daysAgo(1)
            })
        },
        {
            box: 'incoming',
            fromProjectName: 'signalx',
            toProjectName: 'agentic',
            request: request({
                id: 'req_1a44',
                fromProject: 'p_signalx' as ProjectId,
                sender: agent('scout'),
                title: 'Devtools: name signals in traces',
                body: 'Traces show anonymous signals; a name would make them readable.',
                state: 'accepted',
                resultItem: 12,
                createdAt: daysAgo(3)
            })
        },
        ...([
            ['req_0f11', 'signalx', 'Forge', 'Usage rings wait on the batch() fix', 16, 2],
            ['req_0e02', 'zero-wip', 'Lint', 'Adopt zero’s Switch in settings', 11, 4],
            ['req_0d93', 'docs-site', 'Scout', 'Link the runbook from the Home tour', 10, 5],
            ['req_0c84', 'signalx', 'Forge', 'Drop the Signal re-declaration once exported', 8, 6]
        ] as const).map(([id, project, who, title, n, days]): RequestEntry => ({
            box: 'linked',
            fromProjectName: project,
            toProjectName: 'agentic',
            request: request({
                id,
                fromProject: `p_${project}` as ProjectId,
                sender: agent(who.toLowerCase()),
                title,
                body: title,
                state: 'accepted',
                resultItem: n,
                createdAt: daysAgo(days)
            })
        }))
    ]
};
