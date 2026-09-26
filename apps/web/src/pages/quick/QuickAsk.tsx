/**
 * `/quick` (#849): the desktop app's quick-ask window, opened by its global
 * hotkey. Pick an agent, type, Enter: it starts the work the way "Start
 * task" does (`startTaskWith`: a chat with the agent, the text as its first
 * message), then the app's main window opens that chat and this one hides.
 * Esc hides it. The page renders without the app shell (App.tsx), so it
 * stays small. In a browser it works too, and just opens the chat.
 */
import { component, onMounted, onUnmounted, signal, type JSXElement } from 'sigx';
import { useRouter } from '@sigx/router';
import { Button, ErrorNote, SelectField, TextareaField } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { dataMode } from '../../data-mode';
import { desktopHost } from '../../desktop/bridge';
import { useAgentDirectory } from '../chat/directory';
import { startTaskWith } from '../task/start';
import { useLiveWorkdirEnvironments } from '../workdir/environments';
import { canSend, initialAgent, readRemembered, remember, sendsOnKey } from './model';
import { chatHref } from '../chat/href';

const LiveQuickAsk = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const agents = useAgentDirectory(defs, viewer);
    const workdirs = useLiveWorkdirEnvironments(defs, viewer);
    const st = signal({ agentId: '', text: '', busy: false, error: '' });
    // Reading `localStorage` itself can throw (blocked site data), not only its methods.
    const storage = (): Storage | undefined => {
        try {
            return globalThis.localStorage ?? undefined;
        } catch {
            return undefined;
        }
    };
    const hide = (): void => { void desktopHost()?.hideQuick().catch(() => {}); };

    // Esc anywhere hides the window; every time it comes back, the text box has the focus.
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide(); };
    const onFocus = (): void => { document.querySelector<HTMLTextAreaElement>('[data-quick] textarea')?.focus(); };
    onMounted(() => {
        document.addEventListener('keydown', onKey);
        window.addEventListener('focus', onFocus);
        onFocus();
    });
    onUnmounted(() => {
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('focus', onFocus);
    });

    const send = async (): Promise<void> => {
        const ws = viewer.workspaceId;
        if (!ws || !canSend(st.agentId, st.text, st.busy)) return;
        st.busy = true;
        st.error = '';
        try {
            const { chatId } = await startTaskWith(defs, ws, { agentId: st.agentId, objective: st.text, workdir: null, machineId: workdirs.lastMachineId() }, agents.lookup);
            remember(storage(), st.agentId);
            st.text = '';
            const host = desktopHost();
            if (host) await host.openMain(chatHref({ id: chatId }));
            else await router.push(chatHref({ id: chatId }));
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };

    return (): JSXElement => {
        const list = agents.all();
        if (!st.agentId && list.length) st.agentId = initialAgent(list, readRemembered(storage()));
        if (!viewer.pending && !viewer.workspaceId) return <p data-quick-note>Sign in in the Agentic window first.</p>;
        return (
            <form
                data-quick
                aria-label="Quick ask"
                onSubmit={(e: Event) => { e.preventDefault(); void send(); }}
                onKeydown={(e: KeyboardEvent) => {
                    if ((e.target as HTMLElement | null)?.tagName === 'TEXTAREA' && sendsOnKey(e)) {
                        e.preventDefault();
                        void send();
                    }
                }}
            >
                <SelectField model={() => st.agentId} name="quick-agent" label="Agent" options={list.map((a) => ({ value: a.id, label: a.role ? `${a.name} · ${a.role}` : a.name }))} placeholder="Pick an agent" />
                <TextareaField model={() => st.text} name="quick-text" label="Ask" rows={3} placeholder="What should it do? Enter sends, Shift+Enter is a new line." />
                <div data-quick-actions>
                    {st.error ? <ErrorNote>{st.error}</ErrorNote> : <span data-quick-hint>Opens as a new chat · Esc closes</span>}
                    <Button intent="primary" type="submit" loading={st.busy} disabled={!canSend(st.agentId, st.text, st.busy)}>Send</Button>
                </div>
            </form>
        );
    };
}, { name: 'LiveQuickAsk' });

export const QuickAsk = component(() => () => (
    <main data-page="quick">
        {dataMode() === 'live' ? <LiveQuickAsk /> : <p data-quick-note>Quick ask needs the platform (live mode).</p>}
    </main>
), { name: 'QuickAsk' });
