import { component, signal, watch, type Define } from 'sigx';
import type { ReleaseChannel, UpdatePolicy, UpdateSettings } from '@agentic/core';
import { Button, SelectField, TextField } from '@agentic/ui';
import { POLICY_KIND_LABEL, draftOfPolicy, policyLabel, policyOfDraft, samePolicy, validatePolicy, type PolicyDraft } from './update';

/** What Save hands back: the channel and the policy, `null` for "follow the workspace". */
export interface UpdateChoice {
    readonly channel: ReleaseChannel | null;
    readonly policy: UpdatePolicy | null;
}

export type UpdatePolicyFormProps =
    & Define.Prop<'channel', ReleaseChannel | null, true>
    & Define.Prop<'policy', UpdatePolicy | null, true>
    /** A machine's form: the workspace defaults, offered as "Workspace default (…)". Settings passes none. */
    & Define.Prop<'inherit', UpdateSettings>
    /** The zone a window opens in — the workspace's. */
    & Define.Prop<'timeZone', string, true>
    & Define.Prop<'busy', boolean>
    & Define.Prop<'disabled', boolean>
    /** Field names are prefixed with it, so a page can hold two forms. */
    & Define.Prop<'name', string, true>
    /** Bumped by the card's "Schedule": the form switches to a window. */
    & Define.Prop<'windowAsk', number>
    & Define.Event<'save', UpdateChoice>;

/**
 * The release channel and the update policy (#367; OPS-03): a machine's own
 * or the workspace's default. A window is a cron in the workspace zone and
 * how long it stays open — the Schedules page's cron field and its reading.
 */
export const UpdatePolicyForm = component<UpdatePolicyFormProps>(({ props, emit }) => {
    const initial = (): PolicyDraft => draftOfPolicy(props.channel, props.policy);
    const draft = signal<PolicyDraft & { attempted: boolean }>({ ...initial(), attempted: false });
    // A write from anywhere (another tab, the platform's own reply) resets the form to what is stored — by value:
    // a live read hands over a fresh object on every change of the machine, and an edit must survive those.
    watch(() => JSON.stringify([props.channel, props.policy]), () => { Object.assign(draft, initial(), { attempted: false }); });
    watch(() => props.windowAsk, (n) => { if (n) draft.kind = 'window'; });

    const channelOf = (d: PolicyDraft): ReleaseChannel | null => (d.channel === '' ? null : d.channel);
    const dirty = (): boolean => {
        const policy = policyOfDraft(draft, props.timeZone);
        return channelOf(draft) !== props.channel || policy === undefined || !samePolicy(policy, props.policy);
    };
    const save = (): void => {
        draft.attempted = true;
        const policy = policyOfDraft(draft, props.timeZone);
        if (policy === undefined) return;
        emit('save', { channel: channelOf(draft), policy });
    };

    return () => {
        const inherit = props.inherit;
        const errors = draft.attempted ? validatePolicy(draft) : {};
        const channels = [
            ...(inherit ? [{ value: '', label: `Workspace default (${inherit.defaultChannel})` }] : []),
            { value: 'stable', label: 'stable — tested releases' },
            { value: 'latest', label: 'latest — every published build' }
        ];
        const kinds = [
            ...(inherit ? [{ value: '', label: `Workspace default (${policyLabel(inherit.defaultPolicy)})` }] : []),
            ...(Object.keys(POLICY_KIND_LABEL) as UpdatePolicy['kind'][]).map((k) => ({ value: k, label: POLICY_KIND_LABEL[k] }))
        ];
        return (
            <div data-update-policy>
                <div data-settings-pair>
                    <SelectField name={`${props.name}-channel`} label="Release channel" model={() => draft.channel} options={channels} disabled={props.disabled} />
                    <SelectField name={`${props.name}-policy`} label="Takes updates" model={() => draft.kind} options={kinds} disabled={props.disabled} />
                </div>
                {draft.kind === 'window' ? (
                    <div data-settings-pair data-update-window>
                        <TextField model={() => draft.cron} name={`${props.name}-cron`} label="Window opens (cron)" description={`minute hour day month weekday, ${props.timeZone} — 0 3 * * * is daily at 03:00.`} required error={errors.cron} disabled={props.disabled} />
                        <TextField model={() => draft.hours} name={`${props.name}-hours`} label="Stays open (hours)" required error={errors.hours} disabled={props.disabled} />
                    </div>
                ) : null}
                <div data-card-actions>
                    <Button intent="default" loading={props.busy} disabled={props.disabled || props.busy || !dirty()} onClick={save}>Save update settings</Button>
                </div>
            </div>
        );
    };
});
