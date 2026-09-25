/**
 * A plan-backed work item page shows the plan item's refs and its History (#890): the model's helpers, then the page on
 * mock data — a plain task has neither section.
 */
import { describe, it, expect } from 'vitest';
import type { AgentId } from '@agentic/core';
import { activityOf, actorLabel, refHref } from '../../src/pages/projects/work/item/model';
import { mountRoute, page, texts } from '../pages/mount';

const forge = 'forge' as AgentId;

describe('the work item refs and activity model (#890)', () => {
    it('lists History newest first, lines in the same ms newest first too', () => {
        const a = { at: 1, actor: { kind: 'agent' as const, agentId: forge }, text: 'added' };
        const b = { at: 5, actor: { kind: 'agent' as const, agentId: forge }, text: 'claimed' };
        const c = { at: 5, actor: { kind: 'agent' as const, agentId: forge }, text: 'ref pr:5' };
        expect(activityOf({ activity: [a, b, c] }).map((x) => x.text)).toEqual(['ref pr:5', 'claimed', 'added']);
        expect(activityOf({ activity: [] })).toEqual([]);
    });

    it('names an agent, you and the platform', () => {
        expect(actorLabel({ kind: 'agent', agentId: forge }, (id) => id.toUpperCase())).toBe('FORGE');
        expect(actorLabel({ kind: 'user', userId: 'u1' }, () => 'x')).toBe('You');
        expect(actorLabel({ kind: 'user', userId: 'system' }, () => 'x')).toBe('Platform');
    });

    it('links items and pull requests inside the project, URLs out, and prints the rest', () => {
        expect(refHref({ kind: 'item', n: 9 }, 'p1')).toEqual({ to: '/projects/p1/work/item:9', external: false });
        expect(refHref({ kind: 'pr', n: 4 }, 'p1')).toEqual({ to: '/projects/p1/work/pr:4', external: false });
        expect(refHref({ kind: 'url', url: 'https://x.dev/a' }, 'p1')).toEqual({ to: 'https://x.dev/a', external: true });
        expect(refHref({ kind: 'commit', sha: '4f2a9c1' }, 'p1')).toBeUndefined();
        expect(refHref({ kind: 'file', path: 'a/b.ts', from: 1, to: 2 }, 'p1')).toBeUndefined();
    });
});

describe('the work item page refs and History on mock data (#890)', () => {
    it('shows a plan-backed item its refs and its History, newest first', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/item:12');
        const el = page(dom, 'project-work-item')!;
        const refs = [...el.querySelectorAll<HTMLElement>('[data-work-item-refs] [data-work-item-ref]')];
        expect(refs.map((r) => r.dataset['workItemRef'])).toEqual(['item', 'file', 'pr']);
        expect(texts(refs)).toEqual(['#11', 'shell/shell.css:38-41', '#603']);
        expect(refs[0]!.querySelector('a')?.getAttribute('href')).toBe('/projects/p_agentic/work/item:11');
        expect(refs[1]!.querySelector('a')).toBeNull();
        expect(refs[2]!.querySelector('a')?.getAttribute('href')).toBe('/projects/p_agentic/work/pr:603');
        const lines = texts([...el.querySelectorAll('[data-work-item-activity] [data-activity-line]')]);
        expect(lines).toEqual(['Forge claimed #12', 'Atlas assigned #12 to Forge']);
        expect(el.querySelector('[data-work-item-activity] [data-activity-age]')?.textContent).toBeTruthy();
    });

    it('shows a plain task neither refs nor History', async () => {
        const dom = await mountRoute('/projects/p_agentic/work/task:t_52a1');
        const el = page(dom, 'project-work-item')!;
        expect(el.querySelector('[data-work-item-head]')).not.toBeNull();
        expect(el.querySelector('[data-work-item-refs]')).toBeNull();
        expect(el.querySelector('[data-work-item-activity]')).toBeNull();
    });
});
