/**
 * "Folders the web may use" (#355, #482): the machine's policy as the owner
 * edits it from here — each root as asked beside what the daemon made of it
 * (`~ → C:\Users\andy`), a `web` / `local` / `locked` badge and who set it,
 * add by path or **Browse…**, remove, **Save** once the list differs from
 * what is set. The page owns the list (`roots`) and the round trip
 * (`setPolicy` through the elevation helper, then `policyResult`); this is
 * the view. A locked machine is read-only with the unlock command; a
 * daemon that predates web-set policy keeps the local `allow-root` well.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import type { HostOs, MachinePolicy } from '@agentic/core';
import { Button, Label, StatusPill, TextField } from '@agentic/ui';
import { dateTime, WORKSPACE_ZONE } from '../agent/format';
import { CommandWell } from './CommandWell';
import { allowRootCommand, fallbackCommand, policyState } from './manage';
import { policyRootError, policyRows, sameRoots, unlockCommand, type PolicyCardState, type PolicyDesiredView } from './policy';

export type PolicyCardProps =
    & Define.Prop<'name', string, true>
    & Define.Prop<'os', HostOs, true>
    & Define.Prop<'state', PolicyCardState, true>
    & Define.Prop<'policy', MachinePolicy>
    & Define.Prop<'desired', PolicyDesiredView>
    /** The list as edited: what Save sends. */
    & Define.Prop<'roots', readonly string[], true>
    & Define.Prop<'online', boolean, true>
    /** A request is out (Save waits for the daemon). */
    & Define.Prop<'busy', boolean>
    & Define.Prop<'failure', string | null>
    /** A line under the list: "Applied." after a round trip. */
    & Define.Prop<'notice', string | null>
    & Define.Prop<'timeZone', string>
    /** The folder the no-feature well names: the first one the machine's environments work in. */
    & Define.Prop<'likelyRoot', string>
    & Define.Event<'add', string>
    & Define.Event<'remove', string>
    & Define.Event<'browse'>
    & Define.Event<'save'>
    & Define.Event<'reset'>
    /** Below the card's own content: the mock's state picker. */
    & Define.Slot<'default'>;

const BADGE: Readonly<Record<Exclude<PolicyCardState, 'no-feature'>, { readonly label: string; readonly tone: 'live' | 'working' | 'needs-you' | 'failed' }>> = {
    web: { label: 'WEB', tone: 'live' },
    local: { label: 'LOCAL', tone: 'working' },
    locked: { label: 'LOCKED', tone: 'needs-you' },
    off: { label: 'OFF', tone: 'failed' }
};

/** `user:u1` → `u1`; `system:setup` → "the pairing preset". */
const whoLabel = (by: string): string => (by === 'system:setup' ? 'the pairing preset' : by.replace(/^user:/, ''));

export const PolicyCard = component<PolicyCardProps>(({ props, emit, slots }) => {
    const ui = signal({ add: '', addError: '' });
    const add = (): void => {
        const error = policyRootError(ui.add, props.os);
        if (error) {
            ui.addError = error;
            return;
        }
        const path = ui.add.trim();
        ui.addError = props.roots.includes(path) ? `${path} is already in the list.` : '';
        if (!ui.addError) emit('add', path);
        ui.add = '';
    };

    return (): JSXElement => {
        const state = props.state;
        const policy = props.policy;
        if (state === 'no-feature') {
            const local = policyState(policy);
            return (
                <section data-card data-policy-card data-policy-state={state} id="machine-folders" aria-label="Folders the web may use">
                    <div data-label-row><Label>Folders the web may use</Label></div>
                    {local === 'on' ? (
                        <>
                            <p data-card-text>Set on the machine: {policy!.allowedRoots.join(', ')}. The daemon predates web-set folders — to change them from here, reinstall it once from the Pair page; until then, <code>agentic-daemon policy allow-root</code> on the machine.</p>
                        </>
                    ) : (
                        <div data-env-policy={local}>
                            <p data-card-text>
                                {local === 'unknown'
                                    ? `The daemon on ${props.name} does not say whether this page may manage its environments. Update agentic-daemon there, then allow the folder agents may work in:`
                                    : `${props.name} does not let this page manage its environments. Its daemon predates web-set folders — reinstall it once from the Pair page to set them here, or allow the folder agents may work in on the machine:`}
                            </p>
                            <CommandWell command={allowRootCommand(props.likelyRoot)} fallback={fallbackCommand(allowRootCommand(props.likelyRoot), props.os)} />
                            <p data-card-text>The page picks the change up when the daemon reports it.</p>
                        </div>
                    )}
                    {slots.default?.()}
                </section>
            );
        }
        const desired = props.desired;
        const rows = policyRows(props.roots, policy);
        const set = desired ? desired.allowedRoots : policy?.requested ?? policy?.allowedRoots ?? [];
        const dirty = !sameRoots(props.roots, set);
        const locked = state === 'locked';
        const busy = !!props.busy;
        const editable = !locked && !busy;
        const offline = !props.online;
        const who = desired ? `${whoLabel(desired.by)}, ${dateTime(desired.setAt, props.timeZone ?? WORKSPACE_ZONE)}` : null;
        const lead = locked
            ? `Locked on ${props.name}: the web may read these folders but not change them.`
            : state === 'web'
                ? `Set from the web${who ? ` by ${who}` : ''}.`
                : state === 'local'
                    ? `Set on the machine (agentic-daemon policy allow-root)${who ? `; the web last asked for a different set (${who})` : ''}.`
                    : desired
                        ? `Asked for by ${who}; the machine has not applied it yet.`
                        : 'Nothing allowed yet: the web cannot add environments on this machine until a folder is.';
        const waiting = desired && !desired.converged && !dirty && !busy && !locked && state !== 'off';
        return (
            <section data-card data-policy-card data-policy-state={state} data-dirty={dirty ? '' : undefined} id="machine-folders" aria-label="Folders the web may use">
                <div data-label-row>
                    <Label>Folders the web may use</Label>
                    <StatusPill status={state} label={BADGE[state].label} tone={BADGE[state].tone} />
                </div>
                <p data-card-text>{lead}</p>
                {waiting ? <p data-card-text data-policy-waiting role="status">{desired.lastAuto && !desired.lastAuto.converged ? 'The machine refused this set when it last connected. Change it, or fix the folder on the machine and reconnect the daemon.' : 'Waiting for the machine to apply this set.'}</p> : null}
                {rows.length ? (
                    <ul data-policy-roots>
                        {rows.map((r) => (
                            <li data-policy-root={r.requested} data-applied={r.resolved !== undefined ? '' : undefined}>
                                <code data-policy-requested>{r.requested}</code>
                                {r.resolved !== undefined && r.resolved !== r.requested ? <span data-policy-resolved>→ {r.resolved}</span> : null}
                                {r.resolved === undefined && !locked ? <span data-policy-pending>not applied yet</span> : null}
                                {editable ? <Button intent="default" label={`Remove ${r.requested}`} onClick={() => emit('remove', r.requested)}>Remove</Button> : null}
                            </li>
                        ))}
                    </ul>
                ) : <p data-card-text data-policy-empty>No folder in the list{dirty ? ' — Save turns web management off' : ''}.</p>}
                {locked ? (
                    <>
                        <p data-card-text>To change them from here, unlock the policy on the machine:</p>
                        <CommandWell command={unlockCommand()} fallback={fallbackCommand(unlockCommand(), props.os)} />
                    </>
                ) : (
                    <>
                        <div data-policy-add onKeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}>
                            <TextField model={() => ui.add} name="policy-root" label="Add a folder" placeholder={props.os === 'windows' ? '~ or C:\\Dev' : '~ or /home/me/src'} description="~ is the daemon user's home folder on the machine." error={ui.addError || undefined} disabled={busy} />
                            <Button intent="default" disabled={busy} onClick={add}>Add</Button>
                            <Button intent="default" disabled={busy || offline} onClick={() => emit('browse')}>Browse…</Button>
                        </div>
                        {offline ? <p data-env-note>The machine is offline. The folders can be changed while its daemon is connected.</p> : null}
                        <div data-card-actions>
                            <Button intent="primary" loading={busy} disabled={!dirty || busy || offline} onClick={() => emit('save')}>Save folders</Button>
                            {dirty && !busy ? <Button intent="default" onClick={() => emit('reset')}>Discard</Button> : null}
                        </div>
                    </>
                )}
                {props.failure ? <p data-policy-failure role="alert">{props.failure}</p> : null}
                {props.notice ? <p data-policy-notice role="status">{props.notice}</p> : null}
                <p data-card-text data-policy-foot>Changing these asks you to confirm with GitHub once. The daemon still refuses network shares and its own folders, and <code>agentic-daemon policy lock</code> on the machine always wins.</p>
                {slots.default?.()}
            </section>
        );
    };
});
