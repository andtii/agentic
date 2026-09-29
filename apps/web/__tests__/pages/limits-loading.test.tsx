// @vitest-environment happy-dom
/**
 * The Limits card's busy state (#1137): it follows the machines store's
 * `loading`, so a paired machine whose record cannot be read (gone,
 * unreachable) never keeps the whole card loading.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { component, defineApp, type JSXElement } from 'sigx';
import { actorsPlugin } from '@sigx/actors/app';
import { __actorRef, type ActorTransport } from '@sigx/actors/client';
import type { MachineView } from '@agentic/platform';
import { initAppStores, memoryKeyValueStorage, useActorDefs, useKeyValueStorage, useViewer, type ActorDefs } from '@agentic/client';
import { LiveLimits } from '../../src/pages/usage/Limits';

const Workspace = __actorRef('Workspace', '/_sigx/actor', [], []);
const Machine = __actorRef('Machine', '/_sigx/actor', [], []);

const machineView = (id: string): MachineView =>
    ({ id, name: id, online: true, revoked: false, environments: [{ id: 'e1', runtime: 'claude-code', account: { label: 'work' } }], activeSessions: [], quota: {} }) as unknown as MachineView;

/** Two paired machines; `m2`'s record cannot be read. */
const transport: ActorTransport = {
    name: 'limits',
    call: async (symbol, args) => {
        const method = symbol.split('#')[1];
        if (symbol.startsWith('Workspace')) {
            if (method === 'listMachines') return [{ id: 'm1', name: 'm1', status: 'paired' }, { id: 'm2', name: 'm2', status: 'paired' }];
            return method === 'get' ? { settings: {}, machines: [], agents: [], chats: [] } : method === 'projects' ? [] : { projects: [], unassigned: 0 };
        }
        const id = String((args as unknown[])[0]).split(':machine:')[1]!;
        if (id === 'm2') throw new Error('machine gone');
        return machineView(id);
    },
    stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) }),
    live: () => ({ subscribe: () => () => undefined })
};

const Shell = component(() => {
    initAppStores();
    return (): JSXElement => <LiveLimits compact={false} />;
});

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0)) close();
});

const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
        if (ok()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
};

describe('LiveLimits', () => {
    it('stops loading when one paired machine cannot be read', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(<Shell />);
        app.use(actorsPlugin({ transport, live: { debounceMs: 0, retryMs: 10, maxRetryMs: 50 } }));
        app.defineProvide(useActorDefs, () => ({ Workspace, Machine }) as unknown as ActorDefs);
        app.defineProvide(useViewer, () => () => ({ workspaceId: 'ws_limits', pending: false }));
        app.defineProvide(useKeyValueStorage, () => memoryKeyValueStorage());
        app.mount(container);
        closers.push(() => {
            app.unmount();
            container.remove();
        });

        const card = (): HTMLElement | null => container.querySelector('[data-usage-limits]');
        await until(() => !!card()?.textContent?.includes('work'), 'the readable machine’s account');
        await until(() => card()?.getAttribute('aria-busy') !== 'true', 'the card to settle');
        expect(card()!.getAttribute('aria-busy')).toBeNull();
    });
});
