/**
 * The live plumbing (#150) over the wire a browser uses: the Memory, Ledger,
 * TaskIndex and Registry stubs answer under the keys `actors/keys.ts` spells,
 * and `useWorkspaceZone` follows the workspace's saved zone.
 */
import { component } from 'sigx';
import { actor } from '@sigx/actors';
import { Workspace, workspaceKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { useActorDefs, useViewer } from '../../src/actors/defs';
import { ledgerKeyOf, ledgerMonthOf, memoryKeyOf, registryKeyOf, taskIndexKeyOf } from '../../src/actors/keys';
import { useWorkspaceZone } from '../../src/time';
import { USER, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

let h: LiveHarness | null = null;

afterEach(async () => {
    await h?.stop();
    h = null;
});

describe('live plumbing', () => {
    it('the new stubs answer over the wire under the web keys', async () => {
        h = await startLive();
        const agentId = await h.agent('Atlas');
        const defs = clientDefs();

        const memory = actor(defs.Memory, memoryKeyOf(USER, `agent:${agentId}`));
        const put = await memory.put({ kind: 'fact', text: 'the team deploys on fridays', tags: [], confidence: 'stated', provenance: { source: 'user' } });
        expect((await memory.exportPage(null)).entries.map((e) => e.id)).toEqual([put.id]);
        expect(await memory.stats()).toMatchObject({ entries: 1, live: 1 });

        expect(await actor(defs.TaskIndex, taskIndexKeyOf(USER)).list({})).toEqual([]);
        expect(await actor(defs.Ledger, ledgerKeyOf(USER, ledgerMonthOf(Date.now()))).corrections(agentId as never, '2026-W38')).toBe(0);
        expect(await actor(defs.Registry, registryKeyOf(USER)).connectors()).toEqual([]);
    });

    it('useWorkspaceZone reads the saved zone, live', async () => {
        h = await startLive();
        const Zone = component(() => {
            const zone = useWorkspaceZone(useActorDefs(), useViewer()());
            return () => <p data-zone>{zone()}</p>;
        });
        const root = await mountLive('/', h, <Zone />);
        const shown = (): string => root.querySelector('[data-zone]')?.textContent ?? '';
        await until(() => shown() === 'UTC', 'the default zone');
        await h.app.as(owner).actor(Workspace, workspaceKey(USER)).updateSettings({ timeZone: 'Europe/Stockholm' });
        await until(() => shown() === 'Europe/Stockholm', 'the saved zone');
    });
});
