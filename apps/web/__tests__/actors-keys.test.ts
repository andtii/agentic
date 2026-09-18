import { ledgerKey, ledgerMonth, memoryActorKey, registryKey, taskIndexKey } from '@agentic/platform';
import { ledgerKeyOf, ledgerMonthOf, memoryKeyOf, registryKeyOf, taskIndexKeyOf } from '../src/actors/keys';
import { clientDefs } from '../src/actors/client';
import { platformDefs } from '../src/actors.app';

describe('actor keys (#150)', () => {
    it('spell the platform keys exactly', () => {
        expect(taskIndexKeyOf('u1')).toBe(taskIndexKey('u1'));
        expect(registryKeyOf('u1')).toBe(registryKey('u1'));
        expect(memoryKeyOf('u1', 'agent:a1')).toBe(memoryActorKey('u1' as never, 'agent:a1' as never));
        expect(memoryKeyOf('u1', 'shared:team')).toBe(memoryActorKey('u1' as never, 'shared:team'));
        const at = Date.UTC(2026, 0, 31, 23, 59);
        expect(ledgerMonthOf(at)).toBe(ledgerMonth(at));
        expect(ledgerMonthOf(at)).toBe('2026-01');
        expect(ledgerKeyOf('u1', ledgerMonthOf(at))).toBe(ledgerKey('u1' as never, ledgerMonth(at)));
    });

    it('the browser stubs and the SSR definitions name the same actors', () => {
        // A browser stub carries its wire type as `__sigxActor`; a definition as `type`.
        const typeOf = (d: unknown): string => (d as { type?: string; __sigxActor?: string }).type ?? (d as { __sigxActor: string }).__sigxActor;
        const client = clientDefs();
        const server = platformDefs();
        expect(Object.keys(client).sort()).toEqual(Object.keys(server).sort());
        for (const name of Object.keys(client) as (keyof typeof client)[]) expect(typeOf(client[name])).toBe(typeOf(server[name]));
    });
});
