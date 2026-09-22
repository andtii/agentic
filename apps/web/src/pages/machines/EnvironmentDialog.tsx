/**
 * "Add environment" / "Edit environment" (#239): a name, the runtime (what
 * the machine's daemon reports it can host), the folders agents may work in
 * — one per line, inside what the machine allows, with those allowed
 * folders a click away — concurrency, an account label and the
 * `bypassPermissions` switch (#482; on needs elevation). The daemon's policy
 * decides: its refusal comes back as `failure` and lands under the field it
 * concerns. The profile directory is the daemon's own and never appears here.
 */
import { component, signal, watch, type Define } from 'sigx';
import type { EnvironmentDescriptor, EnvironmentInput, HostOs, MachinePolicy } from '@agentic/core';
import { Button, ConfirmDialog, NumberField, SelectField, SwitchField, TextField, TextareaField } from '@agentic/ui';
import { draftOf, emptyDraft, failureField, failureText, inputOf, validateDraft, withRoot, type DraftErrors, type EnvFailure, type EnvironmentDraft } from './manage';

export type EnvironmentDialogProps =
    & Define.Model<boolean>
    /** The environment being changed; absent → a new one. */
    & Define.Prop<'environment', EnvironmentDescriptor>
    & Define.Prop<'runtimes', readonly string[], true>
    & Define.Prop<'policy', MachinePolicy>
    & Define.Prop<'os', HostOs, true>
    /** The other environments' names on this machine. */
    & Define.Prop<'takenNames', readonly string[], true>
    & Define.Prop<'busy', boolean>
    & Define.Prop<'failure', EnvFailure | null>
    & Define.Event<'save', EnvironmentInput>
    & Define.Event<'cancel'>;

export const EnvironmentDialog = component<EnvironmentDialogProps>(({ props, emit }) => {
    const st = signal<{ draft: EnvironmentDraft; attempted: boolean }>({ draft: emptyDraft(props.runtimes), attempted: false });
    // Opening starts from the environment (or a blank one), never from what a cancelled edit left behind —
    // keyed on the environment too, so the page may name it and open the dialog in either order.
    const reset = (): void => {
        st.draft = props.environment ? draftOf(props.environment) : emptyDraft(props.runtimes);
        st.attempted = false;
    };
    watch(() => `${props.model?.value ? 'open' : ''}|${props.environment?.id ?? ''}`, (key) => { if (key.startsWith('open')) reset(); });
    if (props.model?.value) reset();

    const errors = (): DraftErrors => validateDraft(st.draft, { policy: props.policy, os: props.os, runtimes: props.runtimes, takenNames: props.takenNames });

    return () => {
        const d = st.draft;
        const shown = st.attempted ? errors() : {};
        const failure = props.failure ?? null;
        const field = failure ? failureField(failure) : null;
        const errorOf = (name: keyof DraftErrors): string | undefined => shown[name] ?? (failure && field === name ? failureText(failure) : undefined);
        const editing = !!props.environment;
        const allowed = props.policy?.allowedRoots ?? [];
        const runtimeOptions = [...new Set([...props.runtimes, ...(d.runtime ? [d.runtime] : [])])].map((r) => ({ value: r, label: r }));
        return (
            <ConfirmDialog
                model={props.model}
                title={editing ? `Edit ${props.environment!.name}` : 'Add environment'}
                description={editing
                    ? 'The daemon changes it in place; its profile directory and sign-in stay as they are.'
                    : 'The daemon writes it on the machine and gives it its own profile directory. Sign its account in on the machine afterwards.'}
                confirmLabel={editing ? 'Save environment' : 'Add environment'}
                danger={false}
                busy={props.busy}
                onConfirm={() => {
                    st.attempted = true;
                    if (Object.keys(errors()).length) return;
                    emit('save', inputOf(st.draft));
                }}
                onCancel={() => emit('cancel')}
            >
                <div data-env-fields>
                    <TextField model={() => d.name} name="env-name" label="Name" required error={errorOf('name')} disabled={props.busy} />
                    <SelectField model={() => d.runtime} name="env-runtime" label="Runtime" options={runtimeOptions} required error={errorOf('runtime')} disabled={props.busy || editing} description={editing ? 'An environment keeps its runtime; add another for a different one.' : undefined} />
                    <TextareaField
                        model={() => d.roots}
                        name="env-roots"
                        label="Working folders"
                        description="One per line. Agents in this environment work inside these folders only."
                        rows={3}
                        required
                        error={errorOf('roots')}
                        disabled={props.busy}
                    />
                    {allowed.length ? (
                        <div data-env-allowed>
                            <span data-env-allowed-label>Allowed on this machine</span>
                            {allowed.map((root) => (
                                <Button intent="default" disabled={props.busy} onClick={() => { d.roots = withRoot(d.roots, root); }}>{root}</Button>
                            ))}
                        </div>
                    ) : null}
                    <NumberField model={() => d.concurrency} name="env-concurrency" label="Sessions at once" min={1} step={1} placeholder="1" error={errorOf('concurrency')} disabled={props.busy} />
                    <TextField model={() => d.accountLabel} name="env-account" label="Account label" description="How the account shows in pickers; the environment's name when empty." disabled={props.busy} />
                    <SwitchField model={() => d.allowBypass} name="env-bypass" label="Allow bypassPermissions" description="Claude Code may run every tool unasked in this environment. Turning it on asks you to confirm with GitHub once." disabled={props.busy} />
                    {failure && !field ? <p data-env-failure role="alert">{failureText(failure)}</p> : null}
                </div>
            </ConfirmDialog>
        );
    };
});
