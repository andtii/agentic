import { component, signal, watch, type Define } from 'sigx';
import { FormDialog, SelectField, TextField, type RuntimeOption } from '@agentic/ui';
import type { NewAgentInput } from './live';
import { initialRuntime } from './runtimes';

export type NewAgentDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'busy', boolean>
    /** The runtimes to offer (#234); absent, the agent starts on `defaultRuntime` without a choice. */
    & Define.Prop<'runtimes', readonly RuntimeOption[]>
    /** The workspace's `defaults.runtime` — what the dialog opens on when it is offered. */
    & Define.Prop<'defaultRuntime', string>
    & Define.Event<'create', NewAgentInput>
    & Define.Event<'cancel'>;

/** The runtime's name, without the "— needs a key" its option label carries. */
const nameOf = (runtimes: readonly RuntimeOption[] | undefined, id: string): string => (runtimes?.find((r) => r.value === id)?.label ?? id).replace(/ — .*$/, '');

/**
 * "New agent" (AGT-02, #35): a name and a role are enough to create one;
 * everything else is edited on the agent's Config tab, where each save is a
 * new version. It starts on the workspace's default runtime (#234) — the
 * runtime can be picked here, and says so when it cannot run work yet.
 * Confirming without a name keeps the dialog open with the field marked.
 */
export const NewAgentDialog = component<NewAgentDialogProps>(({ props, emit }) => {
    const st = signal({ name: '', role: '', runtime: '', picked: false, attempted: false });
    const fallback = (): string => (props.runtimes?.length ? initialRuntime(props.runtimes, props.defaultRuntime) : (props.defaultRuntime ?? 'anthropic-api'));
    const offered = (id: string): boolean => !props.runtimes?.length || props.runtimes.some((r) => r.value === id);
    // The select follows the workspace default — including when the settings or the runtimes land
    // after the dialog opened — until the person picks one; each opening starts on it again, and a
    // pick that is no longer offered (its plugin was turned off) goes back to it too.
    let syncing = false;
    const follow = (): void => {
        const next = fallback();
        if (st.runtime === next) return;
        syncing = true;
        st.runtime = next;
    };
    // A change from nothing is the select settling on an option, not a person's pick.
    watch(
        () => st.runtime,
        (_next, prev) => {
            if (syncing) syncing = false;
            else if (prev) st.picked = true;
        }
    );
    watch(
        () => (props.model?.value === true ? `open\n${fallback()}` : ''),
        (key) => {
            if (!key) st.picked = false;
            else if (!st.picked || !offered(st.runtime)) follow();
        },
        { immediate: true }
    );
    const runtime = (): string => st.runtime || fallback();
    const chosen = (): RuntimeOption | undefined => props.runtimes?.find((r) => r.value === runtime());
    return () => (
        <FormDialog
            model={props.model}
            title="New agent"
            description={`Give it a name and what it is for. It runs on ${nameOf(props.runtimes, runtime())}; change that, the model and everything else in its config.`}
            submitLabel="Create agent"
            busy={props.busy}
            onSubmit={() => {
                if (!st.name.trim()) {
                    st.attempted = true;
                    return;
                }
                emit('create', { name: st.name, role: st.role, runtime: runtime() });
            }}
            onCancel={() => emit('cancel')}
        >
            <div data-new-agent-fields>
                <TextField model={() => st.name} name="agent-name" label="Name" required error={st.attempted && !st.name.trim() ? 'A name is required.' : undefined} />
                <TextField model={() => st.role} name="agent-role" label="Role" description="What this agent is responsible for." />
                {props.runtimes?.length ? (
                    <SelectField
                        model={() => st.runtime}
                        name="agent-runtime"
                        label="Runtime"
                        options={props.runtimes.map((r) => ({ value: r.value, label: r.label ?? r.value }))}
                        description={chosen()?.hint ?? 'Where its work runs.'}
                    />
                ) : null}
            </div>
        </FormDialog>
    );
});
