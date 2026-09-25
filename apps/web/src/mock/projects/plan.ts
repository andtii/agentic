/**
 * Mock data for the Plan views (#754) — board `Plan`: "Plugin manifests v2" in `agentic`, and the event plan the
 * EventHome Overview card reads. Imported only by the plan feature's own `shared/data.ts`; nothing shared re-exports it.
 */
import type { AgentId, ChatId, Plan, PlanActor, PlanItem, ProjectId, TaskId } from '@agentic/core';
import type { PlanDoc } from '../../pages/projects/features/plan/shared/model';
import { MOCK_NOW } from '../workspace';

const minutesAgo = (m: number): number => MOCK_NOW - m * 60_000;
const agent = (id: string): PlanActor => ({ kind: 'agent', agentId: id as AgentId });

/** The person using the mock workspace, as plans name them. */
export const MOCK_PLAN_VIEWER: PlanActor = { kind: 'user', userId: 'u_andii' };

const atlas = agent('atlas');
const forge = agent('forge');
const lint = agent('lint');
const scout = agent('scout');

const item = (i: Partial<PlanItem> & Pick<PlanItem, 'id' | 'title' | 'state'>): PlanItem => ({ after: [], touches: [], refs: [], doneWhen: [], activity: [], ...i });
const done = (id: number, title: string, who: PlanActor, agoMin: number): PlanItem =>
    item({ id, title, state: 'done', assignee: who, assignedBy: atlas, activity: [{ at: minutesAgo(agoMin), actor: who, text: `marked #${id} done` }] });

const MODEL_TS = 'apps/web/src/pages/plugins/model.ts';
const MANIFEST_TS = 'packages/platform/src/registry/manifest.ts';

const MANIFESTS: Plan = {
    id: 'pl_manifests',
    projectId: 'p_agentic' as ProjectId,
    title: 'Plugin manifests v2',
    description: 'Refactor plugin kinds into declared manifests',
    originChatId: 'c_restructure' as ChatId,
    phases: [
        {
            n: 1,
            title: 'Types in core',
            items: [
                done(1, 'PluginKind and PluginManifest in core', forge, 60 * 26),
                done(2, 'Manifest validator with the slot rules', forge, 60 * 24),
                done(3, 'Conformance fixtures for every kind', lint, 60 * 22),
                done(4, 'Document the manifest fields', scout, 60 * 20)
            ]
        },
        {
            n: 2,
            title: 'Registry and runtime',
            items: [
                item({
                    id: 8, title: 'Registry reads kind from the manifest', state: 'done', assignee: forge, assignedBy: atlas,
                    touches: [MANIFEST_TS], refs: [{ kind: 'pr', n: 601 }, { kind: 'commit', sha: '3be01d2' }, { kind: 'doc', path: 'docs/architecture.md', section: '7' }],
                    doneWhen: [{ text: 'Registry tests read the kind from the manifest', checked: true }],
                    activity: [{ at: minutesAgo(120), actor: forge, text: 'marked #8 done' }]
                }),
                item({
                    id: 9, title: 'Move KIND_ORDER into the manifest registry', state: 'claimed', assignee: forge, assignedBy: atlas, queueIndex: 0,
                    claim: { agentId: 'forge' as AgentId, leaseUntil: minutesAgo(-16), taskId: 't1-1' as TaskId },
                    after: [8], touches: [MODEL_TS, MANIFEST_TS],
                    refs: [
                        { kind: 'file', path: MODEL_TS, from: 38, to: 41, sha: '4f2a9c1' },
                        { kind: 'file', path: MANIFEST_TS, from: 12, to: 60, sha: '4f2a9c1' },
                        { kind: 'commit', sha: '4f2a9c1' },
                        { kind: 'pr', n: 604 },
                        { kind: 'chat', messageId: 'msg-42' },
                        { kind: 'doc', path: 'docs/architecture.md', section: '7' },
                        { kind: 'url', url: 'https://modelcontextprotocol.io/spec' }
                    ],
                    doneWhen: [
                        { text: 'KIND_ORDER comes from the registry', checked: true },
                        { text: 'No kind names left in apps/web', checked: true },
                        { text: 'Plugins page snapshot unchanged', checked: false }
                    ],
                    activity: [
                        { at: minutesAgo(60), actor: atlas, text: 'created from Plan chat' },
                        { at: minutesAgo(52), actor: atlas, text: 'assigned to Forge' },
                        { at: minutesAgo(14), actor: forge, text: 'claimed from the queue, lease 30 min' },
                        { at: minutesAgo(11), actor: forge, text: 'added ref registry/manifest.ts:12-60' },
                        { at: minutesAgo(6), actor: lint, text: 'on #10 touches the same file; will rebase after you' }
                    ]
                }),
                item({
                    id: 10, title: 'Plugins page reads groups from the registry', state: 'claimed', assignee: lint, assignedBy: atlas, queueIndex: 0,
                    claim: { agentId: 'lint' as AgentId, leaseUntil: minutesAgo(-21) },
                    touches: [MODEL_TS],
                    refs: [{ kind: 'file', path: MODEL_TS, from: 12, to: 30, sha: '4f2a9c1' }, { kind: 'item', n: 9 }, { kind: 'pr', n: 605 }, { kind: 'member', handle: 'forge' }],
                    doneWhen: [{ text: 'Groups come from the registry', checked: false }],
                    activity: [{ at: minutesAgo(9), actor: lint, text: 'claimed from the queue, lease 30 min' }]
                }),
                item({
                    id: 11, title: 'Drop the hard-coded SINGLE_SLOT_KINDS', state: 'blocked', assignee: forge, assignedBy: atlas, queueIndex: 0,
                    after: [9], touches: [MODEL_TS], refs: [{ kind: 'file', path: MODEL_TS, from: 44, to: 52, sha: '4f2a9c1' }, { kind: 'item', n: 9 }]
                }),
                item({
                    id: 12, title: 'Decide: keep a2a as its own kind?', state: 'needs-you', assignee: MOCK_PLAN_VIEWER, assignedBy: atlas,
                    refs: [{ kind: 'doc', path: 'docs/decisions.md' }, { kind: 'chat', messageId: 'msg-51' }, { kind: 'url', url: 'https://a2a-protocol.org/latest/specification' }],
                    options: [{ label: 'Keep a2a as its own kind' }, { label: 'Fold a2a into connector' }],
                    activity: [{ at: minutesAgo(60), actor: atlas, text: 'asked you to decide' }]
                }),
                item({
                    id: 13, title: 'Migration for stored manifests', state: 'blocked', assignee: scout, assignedBy: atlas, queueIndex: 0,
                    after: [9], refs: [{ kind: 'doc', path: 'docs/runbook.md', section: '4' }]
                })
            ]
        },
        {
            n: 3,
            title: 'UI and release',
            items: [
                item({ id: 14, title: 'Plugin detail shows declared slots', state: 'ready', assignee: forge, assignedBy: atlas, queueIndex: 1, refs: [{ kind: 'pr', n: 598 }, { kind: 'doc', path: 'docs/design/plugins/HANDOFF-plugins.md' }] }),
                item({
                    id: 16, title: 'Bump SignalX once batch() is fixed', state: 'blocked', assignee: forge, assignedBy: atlas, queueIndex: 2,
                    refs: [{ kind: 'project-item', project: 'signalx', n: 14 }, { kind: 'url', url: 'https://github.com/signalxjs/core/issues/14' }, { kind: 'commit', sha: '9c0de1a' }]
                }),
                item({ id: 15, title: 'Update architecture.md §7', state: 'blocked', after: [10, 11], refs: [{ kind: 'doc', path: 'docs/architecture.md', section: '7' }] }),
                item({ id: 17, title: 'Snapshot the plugins page per kind', state: 'ready', assignee: lint, assignedBy: atlas, queueIndex: 0, after: [10] })
            ]
        }
    ]
};

const FIELD_DAY: Plan = {
    id: 'pl_field_day',
    projectId: 'p_event' as ProjectId,
    title: 'Field day',
    description: 'Everything between the venue and the thank-you notes',
    phases: [
        {
            n: 1,
            title: 'Venue and dates',
            items: [
                done(1, 'Shortlist three venues', scout, 60 * 50),
                done(2, 'Hold the date in every calendar', atlas, 60 * 40),
                item({ id: 3, title: 'Book the venue', state: 'needs-you', assignee: MOCK_PLAN_VIEWER, assignedBy: atlas, options: [{ label: 'Harbour hall' }, { label: 'Old mill' }] })
            ]
        },
        {
            n: 2,
            title: 'Guests',
            items: [
                item({ id: 4, title: 'Choose catering', state: 'blocked', assignee: scout, assignedBy: atlas, queueIndex: 0, after: [3] }),
                item({ id: 5, title: 'Send the invites', state: 'ready', assignee: atlas, assignedBy: atlas, queueIndex: 0 })
            ]
        }
    ]
};

/** A project's plans, by project id. */
export const MOCK_PLANS: Readonly<Record<string, readonly PlanDoc[]>> = {
    p_agentic: [
        {
            plan: MANIFESTS,
            originTitle: 'Plan the Projects restructure',
            runs: { 9: { taskId: 't1-1' as TaskId, taskRef: 't_93d1', machine: 'alien01', branch: '604-mcp-tools', sessionId: 's1' } },
            pins: {
                [`${MODEL_TS}:38-41@4f2a9c1`]: {
                    branch: 'main',
                    lines: [
                        'export const KIND_ORDER: readonly PluginKind[] = [',
                        "    'runtime', 'connector', 'memory', 'learning',",
                        "    'notification', 'trigger', 'a2a', 'project-feature',",
                        '];'
                    ]
                }
            }
        }
    ],
    p_event: [{ plan: FIELD_DAY }]
};
