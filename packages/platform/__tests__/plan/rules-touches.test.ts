/**
 * `setTouches` (#1074): the manager and people replace the paths an item touches; empty is allowed (the item runs
 * alone, #1047); paths are relative to the project; a done or dropped item keeps its touches.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, PlanActor, ProjectId, WorkspaceId } from '@agentic/core';
import { claim, createPlan, emptyBook, itemOf, PlanRuleError, setTouches, TOUCHES_MAX, update, type PlanBook, type PlanCall } from '../../src/plan/rules';

const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const person: PlanActor = { kind: 'user', userId: 'u1' };
const agent = (agentId: AgentId): PlanActor => ({ kind: 'agent', agentId });
const T0 = 1_000_000;

const call = (actor: PlanActor | null, over: Partial<PlanCall> = {}): PlanCall => ({ now: T0, actor, manager: PM, members: [PM, FORGE], limitOf: () => 2, ...over });

function book(): PlanBook {
    const b = emptyBook('ws_1' as WorkspaceId, 'prj_1' as ProjectId);
    createPlan(b, call(person), { title: 'Plan', phases: [{ title: 'Phase 1', items: [{ title: 'one', touches: ['packages/a/'] }, { title: 'two' }, { title: 'three' }] }] });
    return b;
}

const code = (fn: () => unknown): string | undefined => {
    try {
        fn();
        return undefined;
    } catch (error) {
        if (error instanceof PlanRuleError) return error.code;
        throw error;
    }
};

describe('setTouches (#1074)', () => {
    const cases: readonly { readonly name: string; readonly by: PlanActor; readonly item: number; readonly paths: readonly string[]; readonly touches: readonly string[] }[] = [
        { name: 'a person sets them', by: person, item: 2, paths: ['packages/b/', 'apps/web/x.ts'], touches: ['packages/b/', 'apps/web/x.ts'] },
        { name: 'the manager replaces them', by: agent(PM), item: 1, paths: ['packages/c/'], touches: ['packages/c/'] },
        { name: 'empty clears them: the item runs alone', by: person, item: 1, paths: [], touches: [] },
        { name: 'backslashes read as slashes, duplicates kept once', by: person, item: 2, paths: ['packages\\b\\', 'packages/b/'], touches: ['packages/b/'] }
    ];
    for (const c of cases) {
        it(c.name, () => {
            const b = book();
            const out = setTouches(b, call(c.by), c.item, c.paths);
            expect(itemOf(b, c.item).touches).toEqual(c.touches);
            expect(out.changes).toHaveLength(1);
            expect(out.changes[0]).toMatchObject({ op: 'updated', itemId: c.item });
            expect(itemOf(b, c.item).activity.at(-1)?.text).toBe(c.touches.length ? `touches ${c.touches.join(', ')}` : 'touches nothing named, so it runs alone');
        });
    }

    it('the same paths again change nothing', () => {
        const b = book();
        const before = itemOf(b, 1).activity.length;
        expect(setTouches(b, call(person), 1, ['packages/a/']).changes).toEqual([]);
        expect(itemOf(b, 1).activity).toHaveLength(before);
    });

    const refusals: readonly { readonly name: string; readonly by: PlanActor | null; readonly item: number; readonly paths: unknown; readonly code: string; readonly prep?: (b: PlanBook) => void }[] = [
        { name: 'a member agent', by: agent(FORGE), item: 1, paths: ['x/'], code: 'forbidden' },
        { name: 'nobody', by: null, item: 1, paths: ['x/'], code: 'forbidden' },
        { name: 'an absolute path', by: person, item: 1, paths: ['/etc/passwd'], code: 'invalid' },
        { name: 'a drive path', by: person, item: 1, paths: ['C:/x'], code: 'invalid' },
        { name: 'a path out of the project', by: person, item: 1, paths: ['a/../../b'], code: 'invalid' },
        { name: 'an empty path', by: person, item: 1, paths: ['  '], code: 'invalid' },
        { name: 'not a list', by: person, item: 1, paths: 'packages/a/', code: 'invalid' },
        { name: 'too many', by: person, item: 1, paths: Array.from({ length: TOUCHES_MAX + 1 }, (_, i) => `p${i}/`), code: 'invalid' },
        { name: 'an unknown item', by: person, item: 99, paths: ['x/'], code: 'not-found' },
        { name: 'a done item', by: person, item: 1, paths: ['x/'], code: 'done', prep: (b) => update(b, call(person), 1, { state: 'done' }) },
        { name: 'a dropped item', by: person, item: 1, paths: ['x/'], code: 'done', prep: (b) => update(b, call(person), 1, { state: 'dropped' }) }
    ];
    for (const r of refusals) {
        it(`refuses ${r.name}`, () => {
            const b = book();
            r.prep?.(b);
            expect(code(() => setTouches(b, call(r.by), r.item, r.paths as readonly string[]))).toBe(r.code);
            if (b.items[String(r.item)]) expect(itemOf(b, r.item).touches).toEqual(['packages/a/']);
        });
    }

    it('an item given touches may then run beside another (#1047)', () => {
        const b = book();
        const forge = call(agent(FORGE));
        claim(b, forge, 1);
        expect(code(() => claim(b, forge, 2))).toBe('not-independent');
        setTouches(b, call(person), 2, ['packages/b/']);
        expect(code(() => claim(b, forge, 2))).toBeUndefined();
    });
});
