/**
 * A project chat's context (#940, board `PMChat`; HANDOFF "Chat context" slot): what the chat's project brings to its
 * composer and panel. Each enabled feature's `ui.chatRefPrefixes` adds a ref prefix — `#` lists the project's plan
 * items, `pr:` its pull requests — and a context chip in the panel. The To row names who a draft activates, the
 * visiting manager it `@`s included before it has joined, with that manager's project as a chip, and says another
 * project's manager can be brought in.
 *
 * The derivations are pure (tested in `__tests__/chat/project-context.test.ts`); `useChatProjectContext` is the live
 * read: the Registry's feature views, and the Plan and Pulls actors only when a feature asks for their prefix.
 */
import { useActorState } from '@sigx/actors/app';
import type { PlanItem, ProjectFeatureUi, PullRequest } from '@agentic/core';
import type { Visitor } from '@agentic/platform';
import type { Recipient, RefSource } from '@agentic/ui';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { planKeyOf, pullsKeyOf, registryKeyOf } from '../../actors/keys';
import { resolveAddressing, type Addressing, type MockChatMember } from '../../mock/workspace';
import { planItemsOf } from '../projects/work/live';
import { mentionsIn, type AgentLookup } from './live';

/** The prefix that lists plan items, and the one that lists pull requests. */
export const ITEM_PREFIX = '#';
export const PULL_PREFIX = 'pr:';

/** The To row's hint while another project's manager could be brought in and the draft addresses no one. */
export const BRING_IN_HINT = '@ another project’s PM to bring them in';

/** A feature as the Registry lists it: enough to name it and read its `ui` block. */
export interface ChatFeatureView {
    readonly id: string;
    readonly name: string;
    readonly ui: ProjectFeatureUi;
}

/** One context chip: an enabled feature that adds ref prefixes to the chat. */
export interface ContextChip {
    readonly featureId: string;
    readonly label: string;
    readonly prefixes: readonly string[];
}

/** The context chips of a project with `enabled` features, in the project's order; features with no prefix add none. */
export function contextChips(enabled: readonly string[], views: readonly ChatFeatureView[]): ContextChip[] {
    const out: ContextChip[] = [];
    for (const id of enabled) {
        const view = views.find((v) => v.id === id);
        const prefixes = view?.ui.chatRefPrefixes ?? [];
        if (!view || !prefixes.length) continue;
        out.push({ featureId: id, label: view.ui.section?.label ?? view.name, prefixes });
    }
    return out;
}

/** Every prefix the chips add, once each. */
export const chipPrefixes = (chips: readonly ContextChip[]): string[] => [...new Set(chips.flatMap((c) => c.prefixes))];

/** Open before done: a plan item's `done`, a pull request's `merged` / `closed` sort last. */
const itemOpen = (i: PlanItem): boolean => i.state !== 'done';
const pullOpen = (pr: PullRequest): boolean => pr.state === 'open';
const openFirst = <T>(list: readonly T[], open: (x: T) => boolean): T[] => [...list.filter(open), ...list.filter((x) => !open(x))];

/**
 * The composer's ref sources for the enabled `prefixes`: `#` the plan items (`#9 Fix batch()`), `pr:` the pull
 * requests, open ones first. A prefix no source here knows lists nothing yet.
 */
export function chatRefSources(prefixes: readonly string[], items: readonly PlanItem[], pulls: readonly PullRequest[]): RefSource[] {
    const out: RefSource[] = [];
    if (prefixes.includes(ITEM_PREFIX)) out.push({ prefix: ITEM_PREFIX, items: openFirst(items, itemOpen).map((i) => ({ id: String(i.id), label: i.title })) });
    if (prefixes.includes(PULL_PREFIX)) out.push({ prefix: PULL_PREFIX, items: openFirst(pulls, pullOpen).map((pr) => ({ id: String(pr.number), label: pr.title })) });
    return out;
}

/**
 * Who the draft activates, as the To row shows it: mentions ∩ members, else the coordinator, else the single member
 * (`resolveAddressing`) — where a visiting manager the draft `@`s counts as a member, since sending brings it in
 * first. A visitor's chip carries its project. While a manager could still be brought in and the draft `@`s no one,
 * the hint says how.
 */
export function chatAddressing(members: readonly MockChatMember[], draft: string, managers: readonly Visitor[], lookup: AgentLookup): Addressing {
    const memberIds = new Set(members.map((m) => m.agentId));
    const guests = managers.filter((v) => !memberIds.has(v.agentId)).map((v): MockChatMember => ({ agentId: v.agentId, status: 'idle', history: { access: 'all' } }));
    const mentioned = mentionsIn(draft, [...members, ...guests], lookup);
    const joining = guests.filter((g) => (mentioned as readonly string[]).includes(g.agentId));
    const base = resolveAddressing([...members, ...joining], mentioned, lookup);
    const withProject = (r: Recipient): Recipient => {
        const v = managers.find((m) => m.agentId === r.id);
        return v ? { ...r, project: v.projectName } : r;
    };
    const recipients = base.recipients.map(withProject);
    const hint = guests.length && !mentioned.length && recipients.length ? BRING_IN_HINT : base.hint;
    return { recipients, hint };
}

/** A project chat's context, live. */
export interface ChatProjectContext {
    chips(): readonly ContextChip[];
    refs(): readonly RefSource[];
}

/**
 * The context of the project `projectId()` names (none outside a project): the Registry's feature views, then the
 * Plan actor's items only while a feature adds `#` and the Pulls actor's PRs only while one adds `pr:`. Call in setup.
 */
export function useChatProjectContext(
    defs: Pick<ActorDefs, 'Registry' | 'Plan' | 'Pulls'>,
    viewer: Pick<ViewerState, 'workspaceId'>,
    project: () => { readonly id: string; readonly features: Readonly<Record<string, unknown>> } | undefined
): ChatProjectContext {
    const views = useActorState(defs.Registry, () => viewer.workspaceId && project() && ([registryKeyOf(viewer.workspaceId), 'projectFeatures'] as const), { live: true });
    const chips = (): ContextChip[] => {
        const p = project();
        return p ? contextChips(Object.keys(p.features), views.value ?? []) : [];
    };
    const wants = (prefix: string): string | undefined => {
        const p = project();
        return p && chipPrefixes(chips()).includes(prefix) ? p.id : undefined;
    };
    const plan = useActorState(defs.Plan, () => { const ws = viewer.workspaceId; const id = wants(ITEM_PREFIX); return ws && id && ([planKeyOf(ws, id), 'list'] as const); }, { live: true });
    const pulls = useActorState(defs.Pulls, () => { const ws = viewer.workspaceId; const id = wants(PULL_PREFIX); return ws && id && ([pullsKeyOf(ws, id), 'get'] as const); }, { live: true });
    return {
        chips,
        refs: () => {
            return chatRefSources(chipPrefixes(chips()), planItemsOf(plan.value?.plans ?? []), pulls.value?.pulls ?? []);
        }
    };
}
