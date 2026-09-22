/**
 * `/pair` on the platform (#144): the page mints a pairing code through
 * `Workspace.registerMachinePending({ name, allowedRoots })` as soon as it
 * knows the workspace — six characters, single use, ten minutes
 * (architecture §9) — and shows the runbook's install line and the by-hand
 * `agentic-daemon pair` command with the code, this origin and the machine
 * name. The name is what the daemon registers under (`--name`); the folders
 * the web may use (#482, default `~`) ride the pending record and become the
 * machine's policy on its first hello. Changing either mints a fresh code so
 * the index entry and the daemon agree. "New code" after expiry mints again.
 * The pending record is watched live: the moment the daemon redeems the code
 * (`Machine.paired`) the page moves to the machine.
 */
import { component, effect, onMounted, onUnmounted, signal, type JSXElement } from 'sigx';
import { useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { Button, EmptyState, TextField, TextareaField } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, workspaceKeyOf } from '../../actors/keys';
import { pairing } from '../../mock/ops';
import { OpsPage } from '../ops/OpsPage';
import { PairView } from '../Pair';
import { defaultMachineName, pairCommands, secondsLeft } from './live';
import { rootsOf } from './manage';

/** What a fresh machine may use unless the owner says otherwise: the daemon user's home folder. */
export const DEFAULT_PAIR_FOLDERS = '~';

/** The daemon's `--url`: this page's origin in the browser, a placeholder while rendering elsewhere. */
export const pageOrigin = (): string => (typeof location !== 'undefined' ? location.origin : '');

export const LivePair = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const st = signal({ name: '', minted: '', folders: DEFAULT_PAIR_FOLDERS, mintedFolders: '', code: '', expiresIn: 0, machineId: '', busy: false, error: '' });

    /** Register a pending machine under the current name and folders; the code and its expiry replace the page's. */
    const mint = async (ws: string): Promise<void> => {
        const name = st.name.trim();
        if (!name || st.busy) return;
        st.busy = true;
        st.error = '';
        const allowedRoots = rootsOf(st.folders);
        try {
            const r = await actor(defs.Workspace, workspaceKeyOf(ws)).registerMachinePending({ name, allowedRoots });
            st.code = r.pairingCode;
            st.expiresIn = secondsLeft(r.expiresAt, Date.now());
            st.machineId = r.machineId;
            st.minted = name;
            st.mintedFolders = allowedRoots.join('\n');
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };

    // Client only: a server render must not register machines. Once the workspace is known, name and mint.
    let stopMint: (() => void) | undefined;
    onMounted(() => {
        let started = false;
        stopMint = effect(() => {
            const ws = viewer.workspaceId;
            if (!ws || started) return;
            started = true;
            void (async () => {
                try {
                    const index = await actor(defs.Workspace, workspaceKeyOf(ws)).listMachines();
                    st.name = defaultMachineName(index);
                } catch {
                    st.name = 'my-machine';
                }
                await mint(ws);
            })();
        });
    });
    onUnmounted(() => stopMint?.());

    // The pending record, live: `paired` flips when the daemon redeems the code.
    const record = useActorState(defs.Machine, () => { const ws = viewer.workspaceId; return ws && st.machineId ? ([machineKeyOf(ws, st.machineId), 'get'] as const) : false; }, { live: true });
    const stopWatch = effect(() => {
        const v = record.value;
        if (v?.paired && v.machineId === st.machineId) void router.push(`/machines/${v.machineId}`);
    });
    onUnmounted(stopWatch);

    /** The name or the folders changed since the code was minted: mint again so the pending record says what the page says. */
    const changed = (): void => {
        const ws = viewer.workspaceId;
        if (ws && st.name.trim() && (st.name.trim() !== st.minted || rootsOf(st.folders).join('\n') !== st.mintedFolders)) void mint(ws);
    };

    return (): JSXElement => {
        const ws = viewer.workspaceId;
        if (!viewer.pending && !ws) {
            return (
                <OpsPage page="pair" title="Pair a machine" hero>
                    <EmptyState variant="generic" title="Sign in to pair a machine" caption="Machines belong to your workspace." />
                </OpsPage>
            );
        }
        if (!st.code) {
            // Minting failed (network, auth): say so and offer the same mint again, never a dead page.
            return (
                <OpsPage page="pair" title="Pair a machine" hero>
                    <div data-pair-pending aria-busy={st.error ? undefined : 'true'}>
                        {st.error ? (
                            <>
                                <p data-pair-error role="alert">{st.error}</p>
                                <Button intent="primary" disabled={st.busy} onClick={() => { if (ws) void mint(ws); }}>Try again</Button>
                            </>
                        ) : null}
                    </div>
                </OpsPage>
            );
        }
        const commands = pairCommands(pageOrigin(), st.code, st.minted, st.mintedFolders.split('\n'));
        return (
            <>
                <PairView
                    code={st.code}
                    expiresIn={st.expiresIn}
                    install={commands.install}
                    command={commands.pair}
                    grants={pairing.grants}
                    onRenew={() => { if (ws) void mint(ws); }}
                    slots={{
                        name: () => (
                            <>
                                <div onChange={changed}>
                                    <TextField model={() => st.name} name="machine-name" label="Machine name" description="The daemon registers under this name; changing it issues a new code." disabled={st.busy} />
                                </div>
                                <div data-pair-folders onChange={changed}>
                                    <TextareaField
                                        model={() => st.folders}
                                        name="allowed-roots"
                                        label="Folders the web may use"
                                        rows={2}
                                        description="One per line. ~ is the daemon user's home folder on the machine; add more later from the machine's page. Full paths also go on the by-hand command as --allow-root."
                                        disabled={st.busy}
                                    />
                                </div>
                            </>
                        )
                    }}
                />
                {st.error ? <p data-pair-error role="alert">{st.error}</p> : null}
            </>
        );
    };
});
