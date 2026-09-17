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
 */

import { component, type Define } from '@sigx/runtime-core';
import { batch, computed, signal, watch } from '@sigx/reactivity';
import { Button, Field, NativeSelect } from '@sigx/zero';
import type { AgentConfig } from '@agentic/core';
import {
    AGENT_FIELDS as F,
    AGENT_NAME_MAX,
    APPROVAL_CATEGORIES,
    LIMIT_KEYS,
    defaultAgentConfig,
    fromAgentDraft,
    toAgentDraft,
    validateAgentDraft,
    type AgentDraft,
    type AgentErrors,
    type ApprovalCategory,
    type LimitKey
} from './agent-model.js';
import { MultiSelectField, NumberField, SelectField, SwitchField, TextField, TextareaField, type FieldOption } from './fields.js';

export interface AgentFormApi {
    /** Restore the draft from the bound config and clear shown errors. */
    reset(): void;
    /** Validate; on success write the config through the model and emit `submit`. Returns whether it submitted. */
    submit(): boolean;
    errors(): AgentErrors;
    /** The live draft (reactive) — for tests and tooling. */
    readonly draft: AgentDraft;
}

export type AgentFormProps = Define.Model<AgentConfig> &
    Define.Prop<'skills', readonly FieldOption[]> &
    Define.Prop<'tools', readonly FieldOption[]> &
    Define.Prop<'connectors', readonly FieldOption[]> &
    Define.Prop<'agents', readonly FieldOption[]> &
    Define.Prop<'environments', readonly FieldOption[]> &
    Define.Prop<'runtimes', readonly FieldOption[]> &
    Define.Prop<'memoryScopes', readonly FieldOption[]> &
    /** Where the pre-hydration post goes. */
    Define.Prop<'action', string> &
    Define.Prop<'method', 'post' | 'get'> &
    Define.Prop<'submitLabel', string> &
    Define.Prop<'disabled', boolean> &
    Define.Event<'submit', { config: AgentConfig; reason: string }> &
    Define.Event<'invalid', AgentErrors> &
    Define.Expose<AgentFormApi>;

const DEFAULT_RUNTIMES: readonly FieldOption[] = [
    { value: 'anthropic-api', label: 'Anthropic API' },
    { value: 'claude-code', label: 'Claude Code' }
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
const CATEGORY_LABELS: Record<ApprovalCategory, string> = {
    read: 'Read',
    write: 'Write',
    execute: 'Execute',
    network: 'Network',
    destructive: 'Destructive'
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

export const AgentForm = component<AgentFormProps>(
    ({ props, emit, expose }) => {
        const source = (): AgentConfig => props.model?.value ?? defaultAgentConfig();
        const draft = signal<AgentDraft>(toAgentDraft(source()));
        const ui = signal({ attempted: false });
        const errors = computed(() => validateAgentDraft(draft));
        const shown = (): AgentErrors => (ui.attempted ? errors.value : {});

        // a tool picked in the multi-select gets the default mode so its select has a value to post
        watch(
            () => draft.tools,
            (tools) => {
                for (const t of tools) if (!draft.toolModes[t]) draft.toolModes[t] = 'allow';
            }
        );

        const reset = () => {
            batch(() => {
                Object.assign(draft, toAgentDraft(source()));
                ui.attempted = false;
            });
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
        expose({ reset, submit, errors: () => errors.value, draft });

        const onSubmit = (e: Event) => {
            e.preventDefault();
            submit();
        };

        return () => {
            const err = shown();
            const count = Object.keys(err).length;
            return (
                <form data-scope="ai-form" data-part="root" data-form="agent" action={props.action} method={props.method ?? 'post'} onSubmit={onSubmit}>
                    {count ? (
                        <div data-scope="ai-form" data-part="summary" role="alert">
                            {count === 1 ? 'One field needs attention.' : `${count} fields need attention.`}
                        </div>
                    ) : null}

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Identity</legend>
                        <TextField model={() => draft.name} name={F.name} label="Name" required maxlength={AGENT_NAME_MAX} error={err.name} />
                        <TextField model={() => draft.description} name={F.description} label="Description" />
                        <TextField model={() => draft.role} name={F.role} label="Role" description="What this agent is responsible for." />
                        <TextareaField model={() => draft.instructions} name={F.instructions} label="Instructions" rows={8} description="Durable instructions; every change is a new version." />
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Capabilities</legend>
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
                                chip: ({ value, label }) => (
                                    <Field.Root size="xs">
                                        <Field.Label>Mode for {label}</Field.Label>
                                        <NativeSelect.Root model={() => draft.toolModes[value]} name={F.toolMode(value)} options={TOOL_MODE_OPTIONS} />
                                    </Field.Root>
                                )
                            }}
                        />
                        <MultiSelectField model={() => draft.connectors} name={F.connectors} label="Connectors" options={props.connectors} placeholder="Add a connector" />
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Approval policy</legend>
                        <p data-scope="ai-form" data-part="hint">Per tool category. The first matching rule wins; a category without a rule falls back to the tool's own mode.</p>
                        {APPROVAL_CATEGORIES.map((c) => (
                            <SelectField key={c} model={() => draft.approvals[c]} name={F.approval(c)} label={CATEGORY_LABELS[c]} options={APPROVAL_OPTIONS} placeholder="No rule" />
                        ))}
                        {draft.approvalExtra.length ? <input type="hidden" name={F.approvalExtra} value={JSON.stringify(draft.approvalExtra)} /> : null}
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Memory</legend>
                        <MultiSelectField model={() => draft.memoryShared} name={F.memoryShared} label="Shared memory scopes" options={props.memoryScopes} allowCustom placeholder="Add a scope" description="The agent always has its private scope; these are the shared ones it may read." />
                        <SwitchField model={() => draft.autoLearn} name={F.autoLearn} label="Learn lessons from sessions automatically" />
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Execution</legend>
                        <SelectField model={() => draft.runtime} name={F.runtime} label="Runtime" options={props.runtimes ?? DEFAULT_RUNTIMES} required error={err.runtime} />
                        <SelectField model={() => draft.defaultEnvironmentId} name={F.environment} label="Default environment" options={props.environments ?? []} placeholder="Any available" />
                        <TextField model={() => draft.model} name={F.model} label="Model" description="Leave blank for the runtime's default." />
                        <SelectField model={() => draft.offlinePolicy} name={F.offlinePolicy} label="When the environment is offline" options={OFFLINE_OPTIONS} error={err.offlinePolicy} />
                        {LIMIT_KEYS.map((k) => (
                            <NumberField key={k} model={() => draft.limits[k]} name={F.limit(k)} label={LIMIT_LABELS[k]} min={k === 'maxCostUsd' ? 0 : 1} step={k === 'maxCostUsd' ? 0.01 : 1} placeholder="No limit" error={err[`limit:${k}`]} />
                        ))}
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Collaboration</legend>
                        <SwitchField model={() => draft.collaborateAll} name={F.collaborateAll} label="May delegate to every agent in the workspace" />
                        {draft.collaborateAll ? null : <MultiSelectField model={() => draft.collaborators} name={F.collaborators} label="Collaborators" options={props.agents} placeholder="Add an agent" />}
                    </fieldset>

                    <fieldset data-scope="ai-form" data-part="section" disabled={props.disabled}>
                        <legend data-scope="ai-form" data-part="section-title">Save</legend>
                        <TextField model={() => draft.reason} name={F.reason} label="Reason for this change" description="Recorded with the new configuration version." />
                        <div data-scope="ai-form" data-part="actions">
                            <Button.Root type="submit" color="primary" disabled={props.disabled}>
                                {props.submitLabel ?? 'Save'}
                            </Button.Root>
                            <Button.Root type="button" variant="ghost" disabled={props.disabled} onClick={reset}>
                                Reset
                            </Button.Root>
                        </div>
                    </fieldset>
                </form>
            );
        };
    },
    { name: 'AgentForm' }
);
