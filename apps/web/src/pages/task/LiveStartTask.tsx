/**
 * The "Start task" dialog on the platform (#193): the pages with the topbar
 * button (Tasks, an agent's page) mount it; starting opens the chat the
 * task was posted in.
 */
import { component, signal, type JSXElement } from 'sigx';
import { useRouter } from '@sigx/router';
import { useActorDefs, useViewer } from '../../actors/defs';
import { useAgentDirectory } from '../chat/directory';
import { useLiveWorkdirEnvironments } from '../workdir/environments';
import { closeStartTask, startTaskRequest, startTaskWith, type StartTaskInput } from './start';
import { StartTaskDialog } from './StartTaskDialog';

export const LiveStartTask = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const agents = useAgentDirectory(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    const st = signal({ busy: false, error: '' });

    const start = async (input: StartTaskInput): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            // The machine (#414): the folder's when one was picked, else the one used last.
            const machineId = (input.workdir ? workdirs.machineOf(input.workdir.environmentId) : undefined) ?? workdirs.lastMachineId();
            const { chatId } = await startTaskWith(defs, ws, { ...input, machineId }, agents.lookup);
            closeStartTask();
            await router.push(`/chats/${chatId}`);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };

    return (): JSXElement => (
        <StartTaskDialog
            model={() => startTaskRequest.open}
            agents={agents.all()}
            agentId={startTaskRequest.agentId}
            workdirs={workdirs}
            busy={st.busy}
            error={st.error}
            onStart={(input) => { void start(input); }}
            onCancel={() => { st.error = ''; closeStartTask(); }}
        />
    );
});
