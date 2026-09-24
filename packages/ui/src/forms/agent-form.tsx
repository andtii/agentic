/**
 * `AgentForm` — every configurable part of an `AgentConfig` (AGT-02) on one
 * form, bound through zero's `model=` contract and posting pre-hydration.
 *
 * Bind the config with a getter: `<AgentForm model={() => state.config} />`.
 * The form edits a draft; a valid submit writes the config back through the
 * model and emits `submit` with the config and the version reason (AGT-06).
 * An invalid submit is blocked, the errors are shown beside their fields and
 * `invalid` is emitted. `reset()` restores the draft from the model.
 *
 * Without JS the same form posts to `action` with the field names in
 * `AGENT_FIELDS`; `parseAgentFormData` turns that post into the same config.
 *
 * Two layouts (`docs/design/HANDOFF.md` → Agent config): the default stacks
 * the sections; `layout="sections"` renders each as a two-column row with a
 * title-and-hint column beside the controls and moves the save card into
 * the `rail` slot (still inside the form, so the reason posts). Both bind
 * the same model and post the same field names.
 */

import { component, type Define, type JSXElement } from '@sigx/runtime-core';
import { batch, computed, signal, watch } from '@sigx/reactivity';
import { Field, Select } from '@sigx/zero';
import type { AgentConfig } from '@agentic/core';
import {
    AGENT_FIELDS as F,
    AGENT_NAME_MAX,
    APPROVAL_CATEGORIES,
    CUSTOM_MODEL,
    LIMIT_KEYS,
    defaultAgentConfig,
    fromAgentDraft,
    modelChoice,
    toAgentDraft,
    validateAgentDraft,
    type AgentDraft,
    type AgentErrors,
    type ApprovalCategory,
    type LimitKey,
    type RuntimeOption
} from './agent-model.js';
import { MultiSelectField, NumberField, SelectField, SwitchField, TextField, TextareaField, type FieldOption } from './fields.js';
import { Button } from '../kit/Button.js';
import { ErrorNote } from '../kit/ErrorNote.js';
import { Segmented } from '../kit/Segmented.js';
import { modelDisplayName } from '../kit/model-name.js';

export interface AgentFormApi {
    /** Restore the draft from the bound config and clear shown errors. */
    reset(): void;
    /** Validate; on success write the config through the model and emit `submit`. Returns whether it submitted. */
    submit(): boolean;
    errors(): AgentErrors;
    /** Whether the draft differs from the bound config — the save card shows only then. */
    dirty(): boolean;
    /** The live draft (reactive) — for tests and tooling. */
    readonly draft: AgentDraft;
}

/** What the `rail` slot receives: the form API plus the config it is bound to. */
export interface AgentFormRailProps extends AgentFormApi {
    readonly config: AgentConfig;
}

export type AgentFormLayout = 'stack' | 'sections';

/** An account the form offers (#414): the key as the value, the label naming the login and the machines it is on. */
export interface AccountOption extends FieldOption {
    readonly runtime: string;
}

/**
 * What the `workdir` slot is handed (#193): the default environment and
 * folder as drafted, and `set` to change both at once — a folder belongs to
 * its environment. Choosing another environment in the select clears the
 * folder. The folder posts through a hidden `AGENT_FIELDS.workdir` input.
 */
export interface AgentFormWorkdirProps {
    readonly environmentId: string;
    readonly path: string;
    set(ref: { readonly environmentId: string; readonly path: string } | null): void;
}

export type AgentFormProps = Define.Model<AgentConfig> &
    Define.Prop<'skills', readonly FieldOption[]> &
    Define.Prop<'tools', readonly FieldOption[]> &
    Define.Prop<'connectors', readonly FieldOption[]> &
    Define.Prop<'agents', readonly FieldOption[]> &
    Define.Prop<'environments', readonly FieldOption[]> &
    /** The accounts to offer (#414): one per login the machines report, each `value` an account key and `runtime` the runtime it belongs to. */
    Define.Prop<'accounts', readonly AccountOption[]> &
    /** The runtimes to offer (#234): each may carry why it is not ready yet and the models it names. */
    Define.Prop<'runtimes', readonly RuntimeOption[]> &
    Define.Prop<'memoryScopes', readonly FieldOption[]> &
    /** Where the pre-hydration post goes. */
    Define.Prop<'action', string> &
    Define.Prop<'method', 'post' | 'get'> &
    Define.Prop<'submitLabel', string> &
    Define.Prop<'disabled', boolean> &
    /** `sections`: two-column rows (title + hint, then controls) with the save card in the `rail` slot. */
    Define.Prop<'layout', AgentFormLayout> &
    /** `segmented`: allow / ask / deny as a segmented control per category (posts through a hidden input). */
    Define.Prop<'approvalControl', 'select' | 'segmented'> &
    Define.Event<'submit', { config: AgentConfig; reason: string }> &
    Define.Event<'invalid', AgentErrors> &
    /** Rendered inside the form beside the sections; when given, the default save section is not rendered. */
    Define.Slot<'rail', AgentFormRailProps> &
    /** Rendered under "Default environment": the default working folder's picker (the app mounts one). */
    Define.Slot<'workdir', AgentFormWorkdirProps> &
    Define.Expose<AgentFormApi>;

const DEFAULT_RUNTIMES: readonly RuntimeOption[] = [
    { value: 'anthropic-api', label: 'Anthropic API' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'copilot-cli', label: 'Copilot CLI' },
    { value: 'codex-cli', label: 'Codex' }
];
const TOOL_MODE_OPTIONS: readonly FieldOption[] = [
    { value: 'allow', label: 'Allow' },
    { value: 'ask', label: 'Ask' },
    { value: 'deny', label: 'Deny' }
];
const APPROVAL_OPTIONS: readonly FieldOption[] = TOOL_MODE_OPTIONS;
const OFFLINE_OPTIONS: readonly FieldOption[] = [
    { value: 'queue', label: 'Queue until it is back' },
    { value: 'fail', label: 'Fail the task' },
    { value: 'fallback-api', label: 'Fall back to the API runtime' }
];
const INTERRUPT_OPTIONS: readonly FieldOption[] = [
    { value: 'ask', label: 'Ask me' },
    { value: 'auto', label: 'Resume automatically, once' }
];
const CATEGORY_LABELS: Record<ApprovalCategory, string> = {
    read: 'Read',
    write: 'Write',
    execute: 'Execute',
    network: 'Network',
    destructive: 'Destructive'
};
const CATEGORY_HINTS: Record<ApprovalCategory, string> = {
    read: 'Read, Grep, memory_search',
    write: 'Edit, Write under the owner paths',
    execute: 'Bash and other commands',
    network: 'network, delegate, connectors',
    destructive: 'git push, rm, force flags'
};
const SEGMENTS: readonly { value: string; label: string; tone: 'live' | 'needs-you' | 'failed' }[] = [
    { value: 'allow', label: 'allow', tone: 'live' },
    { value: 'ask', label: 'ask', tone: 'needs-you' },
    { value: 'deny', label: 'deny', tone: 'failed' }
];
const SECTION_HINTS: Record<string, string> = {
    identity: 'Persists across chats, sessions and environment changes.',
    capabilities: 'A skill is knowledge. It never grants access by itself.',
    approval: 'First matching rule wins. Delegated work inherits this, never wider.',
    memory: 'The private scope is always there; shared scopes are opt-in.',
    execution: 'The default. You can override it when starting work. It never switches by itself.',
    collaboration: 'Who this agent may hand work to.',
    save: 'Every change is a new version you can roll back.'
};
const LIMIT_LABELS: Record<LimitKey, string> = {
    maxTurns: 'Max turns',
    maxSteps: 'Max steps',
    maxTokens: 'Max tokens',
    maxCostUsd: 'Max cost (USD)',
    maxWallMs: 'Max wall time (ms)',
    maxDepth: 'Max delegation depth',
    maxConcurrentChildren: 'Max concurrent children'
};

/** The select's options: a runtime that is not ready says so in its label, beside the hint the form draws under it. */
function runtimeFieldOptions(runtimes: readonly RuntimeOption[]): FieldOption[] {
    return runtimes.map((r) => ({ value: r.value, label: r.label ?? r.value, ...(r.disabled ? { disabled: true } : {}) }));
}

function modelOptions(models: readonly string[], defaultModel: string | undefined): FieldOption[] {
    return [
        { value: '', label: defaultModel ? `Runtime default (${modelDisplayName(defaultModel)})` : 'Runtime default' },
        // Named as a person reads it (#517), the id it runs as beside it.
        ...models.map((m) => {
            const name = modelDisplayName(m);
            return { value: m, label: name === m ? m : `${name} — ${m}` };
        }),
        { value: CUSTOM_MODEL, label: 'Custom…' }
    ];
}

/**
 * Where to fix what the chosen runtime's hint says (#234). The hint itself is
 * the select's `description`, so `aria-describedby` announces it with the
 * field; the link sits beside it.
 */
function runtimeFix(runtime: RuntimeOption | undefined): JSXElement | null {
    if (!runtime?.hint || !runtime.href) return null;
    return (
        <p data-scope="ai-form" data-part="hint" data-runtime-fix={runtime.value}>
            <a href={runtime.href}>{runtime.hrefLabel ?? 'Set it up'}</a>
        </p>
    );
}

export const AgentForm = component<AgentFormProps>(
    ({ props, emit, expose, slots }) => {
        const source = (): AgentConfig => props.model?.value ?? defaultAgentConfig();
        const draft = signal<AgentDraft>(toAgentDraft(source()));
        const runtimes = (): readonly RuntimeOption[] => props.runtimes ?? DEFAULT_RUNTIMES;
        const chosenRuntime = (): RuntimeOption | undefined => runtimes().find((r) => r.value === draft.runtime);
        const models = (): readonly string[] => chosenRuntime()?.models ?? [];
        // `modelChoice` is what the model select shows; `customPicked` keeps "Custom…" open once a person chose it.
        const ui = signal({ attempted: false, modelChoice: modelChoice(draft.model, models()), customPicked: false });
        const errors = computed(() => validateAgentDraft(draft));
        const shown = (): AgentErrors => (ui.attempted ? errors.value : {});
        // Dirty against the canonical form of the bound config, so an untouched draft is clean.
        const dirty = (): boolean => JSON.stringify(fromAgentDraft(draft)) !== JSON.stringify(fromAgentDraft(toAgentDraft(source())));

        // a tool picked in the multi-select gets the default mode so its tag's select has a value to post
        watch(
            () => draft.tools,
            (tools) => {
                for (const t of tools) if (!draft.toolModes[t]) draft.toolModes[t] = 'allow';
            }
        );

        // A folder belongs to its environment: another environment chosen in the select drops it.
        let pickingWorkdir = false;
        watch(
            () => draft.defaultEnvironmentId,
            (next, prev) => {
                if (pickingWorkdir) pickingWorkdir = false;
                else if (next !== prev && draft.defaultWorkdir) draft.defaultWorkdir = '';
            }
        );
        // An account binds the agent to a login on whichever machine the chat names (#414): a pin and its folder go with it.
        watch(
            () => draft.account,
            (next, prev) => {
                if (next && next !== prev && (draft.defaultEnvironmentId || draft.defaultWorkdir)) {
                    batch(() => {
                        draft.defaultEnvironmentId = '';
                        draft.defaultWorkdir = '';
                    });
                }
            }
        );
        // The other way round: a pin picked while an account is set unbinds the account.
        watch(
            () => draft.defaultEnvironmentId,
            (next, prev) => {
                if (next && next !== prev && draft.account) draft.account = '';
            }
        );
        const accountOptions = (): FieldOption[] => (props.accounts ?? []).filter((a) => a.runtime === draft.runtime).map(({ value, label }) => ({ value, label }));
        const setWorkdir = (ref: { readonly environmentId: string; readonly path: string } | null): void => {
            batch(() => {
                if (ref && ref.environmentId !== draft.defaultEnvironmentId) {
                    pickingWorkdir = true;
                    draft.defaultEnvironmentId = ref.environmentId;
                }
                draft.defaultWorkdir = ref?.path ?? '';
            });
        };

        // The model select: a person's pick writes the draft (Custom… keeps what is typed); the form's
        // own sync — a reset, another runtime, the runtimes' models arriving — only moves the select.
        let syncingChoice = false;
        const syncChoice = (): void => {
            const next = modelChoice(draft.model, models());
            if (next === ui.modelChoice) return;
            syncingChoice = true;
            ui.modelChoice = next;
        };
        watch(
            () => ui.modelChoice,
            (choice) => {
                if (syncingChoice) {
                    syncingChoice = false;
                    return;
                }
                ui.customPicked = choice === CUSTOM_MODEL;
                if (choice !== CUSTOM_MODEL) draft.model = choice;
            }
        );
        watch(
            () => `${draft.runtime}\n${models().join('\n')}`,
            () => {
                if (!ui.customPicked) syncChoice();
            }
        );

        const reset = () => {
            batch(() => {
                Object.assign(draft, toAgentDraft(source()));
                ui.attempted = false;
                ui.customPicked = false;
            });
            syncChoice();
        };
        const submit = (): boolean => {
            ui.attempted = true;
            const e = errors.value;
            if (Object.keys(e).length) {
                emit('invalid', e);
                return false;
            }
            const config = fromAgentDraft(draft);
            if (props.model) props.model.value = config;
            emit('submit', { config, reason: draft.reason });
            return true;
        };
        const api: AgentFormApi = { reset, submit, errors: () => errors.value, dirty, draft };
        expose(api);

        const onSubmit = (e: Event) => {
            e.preventDefault();
            submit();
        };

        return () => {
            const err = shown();
            const count = Object.keys(err).length;
            const sections = props.layout === 'sections';
            const segmented = props.approvalControl === 'segmented';
            const rail = sections ? slots.rail : undefined;

            // One section: a fieldset (so `disabled` reaches every control) whose legend names the
            // group. In the sections layout the legend is visually hidden and a title-and-hint column
            // sits beside the controls; the stack layout shows the legend as the heading.
            const section = (key: string, title: string, body: JSXElement | JSXElement[]) => (
                <fieldset data-scope="ai-form" data-part="section" data-section={key} disabled={props.disabled}>
                    <legend data-scope="ai-form" data-part="section-title" data-visually-hidden={sections ? '' : undefined}>{title}</legend>
                    {sections ? (
                        <div data-scope="ai-form" data-part="section-head" aria-hidden="true">
                            <span data-scope="ai-form" data-part="section-heading">{title}</span>
                            <p data-scope="ai-form" data-part="section-hint">{SECTION_HINTS[key]}</p>
                        </div>
                    ) : null}
                    {sections ? <div data-scope="ai-form" data-part="section-body">{body}</div> : body}
                </fieldset>
            );

            const approvalRows = APPROVAL_CATEGORIES.map((c) =>
                segmented ? (
                    <div key={c} data-scope="ai-form" data-part="policy-row">
                        <div data-scope="ai-form" data-part="policy-label">
                            <span>{CATEGORY_LABELS[c]}</span>
                            <small>{CATEGORY_HINTS[c]}</small>
                        </div>
                        <Segmented model={() => draft.approvals[c]} name={F.approval(c)} label={`${CATEGORY_LABELS[c]} policy`} options={SEGMENTS} disabled={props.disabled} />
                    </div>
                ) : (
                    <SelectField key={c} model={() => draft.approvals[c]} name={F.approval(c)} label={CATEGORY_LABELS[c]} options={APPROVAL_OPTIONS} placeholder="No rule" />
                )
            );

            const body = (
                <>
                    {section('identity', 'Identity', (
                        <>
                            <TextField model={() => draft.name} name={F.name} label="Name" required maxlength={AGENT_NAME_MAX} error={err.name} />
                            <TextField model={() => draft.description} name={F.description} label="Description" />
                            <TextField model={() => draft.role} name={F.role} label="Role" description="What this agent is responsible for." />
                            <TextareaField model={() => draft.instructions} name={F.instructions} label="Instructions" rows={8} description="Durable instructions; every change is a new version." />
                        </>
                    ))}

                    {section('capabilities', 'Capabilities', (
                        <>
                            <MultiSelectField model={() => draft.skills} name={F.skills} label="Skills" options={props.skills} allowCustom placeholder="Add a skill" description="Reusable procedures. A skill never grants authority; tools do." />
                            <MultiSelectField
                                model={() => draft.tools}
                                name={F.tools}
                                label="Tools"
                                options={props.tools}
                                allowCustom
                                placeholder="Add a tool"
                                description="What the agent may call; the mode routes a tool through approval or denies it."
                                slots={{
                                    tag: ({ value, label }) => (
                                        <Field.Root size="xs">
                                            <Field.Label>Mode for {label}</Field.Label>
                                            <Select.Root model={() => draft.toolModes[value]} name={F.toolMode(value)} items={TOOL_MODE_OPTIONS} itemValue={(o) => o.value} />
                                        </Field.Root>
                                    )
                                }}
                            />
                            <MultiSelectField model={() => draft.connectors} name={F.connectors} label="Connectors" options={props.connectors} placeholder="Add a connector" />
                        </>
                    ))}

                    {section('approval', 'Approval policy', (
                        <>
                            {segmented ? null : <p data-scope="ai-form" data-part="hint">Per tool category. The first matching rule wins; a category without a rule falls back to the tool's own mode.</p>}
                            {approvalRows}
                            {draft.approvalExtra.length ? <input type="hidden" name={F.approvalExtra} value={JSON.stringify(draft.approvalExtra)} /> : null}
                        </>
                    ))}

                    {section('memory', 'Memory', (
                        <>
                            <MultiSelectField model={() => draft.memoryShared} name={F.memoryShared} label="Shared memory scopes" options={props.memoryScopes} allowCustom placeholder="Add a scope" description="The agent always has its private scope; these are the shared ones it may read." />
                            <SwitchField model={() => draft.autoLearn} name={F.autoLearn} label="Learn lessons from sessions automatically" />
                        </>
                    ))}

                    {section('execution', 'Execution', (
                        <>
                            <div data-runtime-field="" data-runtime-hint={chosenRuntime()?.hint ? chosenRuntime()!.value : undefined}>
                                <SelectField model={() => draft.runtime} name={F.runtime} label="Runtime" options={runtimeFieldOptions(runtimes())} required error={err.runtime} description={chosenRuntime()?.hint} />
                                {runtimeFix(chosenRuntime())}
                            </div>
                            {draft.runtime !== 'anthropic-api' ? (
                                <SelectField
                                    model={() => draft.account}
                                    name={F.account}
                                    label="Account"
                                    options={accountOptions()}
                                    placeholder={accountOptions().length ? 'None — pinned to one environment' : 'No account reported for this runtime yet'}
                                    description={draft.account && !accountOptions().some((o) => o.value === draft.account) ? 'No environment reports this account any more — sign it in on a machine, or pick another.' : 'The login the agent runs as, on whichever machine a chat names. Sign in on each machine with agentic-daemon env login.'}
                                />
                            ) : null}
                            <SelectField model={() => draft.defaultEnvironmentId} name={F.environment} label={draft.account ? 'Pin to one environment (advanced)' : 'Default environment'} options={props.environments ?? []} placeholder="Any available" description={draft.account ? 'Pinning drops the account: the agent then runs in this one environment only.' : undefined} />
                            <input type="hidden" name={F.workdir} value={draft.defaultWorkdir} />
                            {slots.workdir ? slots.workdir({ environmentId: draft.defaultEnvironmentId, path: draft.defaultWorkdir, set: setWorkdir }) : null}
                            {models().length ? (
                                <>
                                    <SelectField model={() => ui.modelChoice} name={F.model} label="Model" options={modelOptions(models(), chosenRuntime()?.defaultModel)} description="The runtime's default unless you pick one." />
                                    {ui.modelChoice === CUSTOM_MODEL ? <TextField model={() => draft.model} name={F.modelCustom} label="Model id" description="Any id the runtime accepts; blank runs on its default." /> : null}
                                </>
                            ) : (
                                <TextField model={() => draft.model} name={F.model} label="Model" description="Leave blank for the runtime's default." />
                            )}
                            <SelectField model={() => draft.offlinePolicy} name={F.offlinePolicy} label="When the environment is offline" options={OFFLINE_OPTIONS} error={err.offlinePolicy} />
                            <SelectField model={() => draft.onInterrupt} name={F.onInterrupt} label="When a turn is interrupted" options={INTERRUPT_OPTIONS} description="A machine that restarts or updates mid-turn cuts the turn short. Nothing is replayed, and what ran before the cut is uncertain. Automatic resumes once when the machine is back; check side effects first." />
                            {LIMIT_KEYS.map((k) => (
                                <NumberField key={k} model={() => draft.limits[k]} name={F.limit(k)} label={LIMIT_LABELS[k]} min={k === 'maxCostUsd' ? 0 : 1} step={k === 'maxCostUsd' ? 0.01 : 1} placeholder="No limit" error={err[`limit:${k}`]} />
                            ))}
                        </>
                    ))}

                    {section('collaboration', 'Collaboration', (
                        <>
                            <SwitchField model={() => draft.collaborateAll} name={F.collaborateAll} label="May delegate to every agent in the workspace" />
                            {draft.collaborateAll ? null : <MultiSelectField model={() => draft.collaborators} name={F.collaborators} label="Collaborators" options={props.agents} placeholder="Add an agent" />}
                        </>
                    ))}

                    {rail ? null : section('save', 'Save', (
                        <>
                            <TextField model={() => draft.reason} name={F.reason} label="Reason for this change" description="Recorded with the new configuration version." />
                            <div data-scope="ai-form" data-part="actions">
                                <Button type="submit" intent="primary" disabled={props.disabled}>
                                    {props.submitLabel ?? 'Save'}
                                </Button>
                                <Button intent="default" disabled={props.disabled} onClick={reset}>
                                    Reset
                                </Button>
                            </div>
                        </>
                    ))}
                </>
            );

            // In the two-column layout the summary heads the sections column, so it never takes a grid cell of its own.
            const summary = count ? <ErrorNote data-form-summary="">{count === 1 ? 'One field needs attention.' : `${count} fields need attention.`}</ErrorNote> : null;

            return (
                <form data-scope="ai-form" data-part="root" data-form="agent" data-layout={props.layout ?? 'stack'} action={props.action} method={props.method ?? 'post'} onSubmit={onSubmit}>
                    {rail ? null : summary}
                    {rail ? (
                        <>
                            <div data-scope="ai-form" data-part="sections">{summary}{body}</div>
                            <aside data-scope="ai-form" data-part="rail">{rail({ ...api, config: source() })}</aside>
                        </>
                    ) : body}
                </form>
            );
        };
    },
    { name: 'AgentForm' }
);
