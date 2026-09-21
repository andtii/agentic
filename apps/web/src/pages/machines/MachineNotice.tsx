import { component, signal, type Define } from 'sigx';
import type { NotificationKind } from '@agentic/core';
import { Button, Icon, StatusPill, type Tone } from '@agentic/ui';
import { LinkButton } from '../ops/LinkButton';

/** The Inbox kinds a machine's daemon raises (#365), with how their pill reads. */
export const MACHINE_NOTICE: Readonly<Partial<Record<NotificationKind, { readonly label: string; readonly tone: Tone }>>> = {
    'update-available': { label: 'UPDATE', tone: 'needs-you' },
    'update-applied': { label: 'UPDATED', tone: 'live' },
    'update-failed': { label: 'UPDATE FAILED', tone: 'failed' },
    'daemon-crash-loop': { label: 'RESTARTING', tone: 'failed' },
    'harness-update-available': { label: 'HARNESS', tone: 'needs-you' }
};

export const isMachineNotice = (kind: string): boolean => Object.hasOwn(MACHINE_NOTICE, kind);

/**
 * One machine notice in "Needs you" (#367): an update is available, applied
 * or failed, or the daemon keeps restarting — with a link to the machine's
 * page, where it is acted on, and Dismiss (`Inbox.ack`).
 */
export const MachineNotice = component<
    & Define.Prop<'kind', NotificationKind, true>
    & Define.Prop<'title', string, true>
    & Define.Prop<'body', string>
    & Define.Prop<'machineId', string, true>
    & Define.Prop<'age', string>
    & Define.Prop<'dismiss', () => Promise<void>>
>(({ props }) => {
    const st = signal({ busy: false, error: '' });
    const dismiss = (): void => {
        if (!props.dismiss || st.busy) return;
        st.busy = true;
        st.error = '';
        props.dismiss().catch((e: unknown) => { st.error = e instanceof Error ? e.message : String(e); }).finally(() => { st.busy = false; });
    };
    return () => {
        const spec = MACHINE_NOTICE[props.kind] ?? { label: props.kind.toUpperCase(), tone: 'muted' as Tone };
        return (
            <article data-machine-notice data-kind={props.kind} aria-label={props.title}>
                <span data-machine-notice-glyph aria-hidden="true"><Icon name="machines" size={16} /></span>
                <div data-machine-notice-head>
                    <StatusPill status={props.kind} label={spec.label} tone={spec.tone} />
                    <span data-machine-notice-title title={props.title}>{props.title}</span>
                </div>
                <p data-machine-notice-context>
                    {props.body ? <span>{props.body}</span> : null}
                    {props.age ? <span> · {props.age}</span> : null}
                </p>
                <div data-machine-notice-actions>
                    <LinkButton to={`/machines/${props.machineId}`} label="Open machine">Open machine</LinkButton>
                    {props.dismiss ? <Button intent="default" loading={st.busy} disabled={st.busy} onClick={dismiss}>Dismiss</Button> : null}
                </div>
                {st.error ? <p data-needs-error role="alert">{`Could not dismiss: ${st.error}`}</p> : null}
            </article>
        );
    };
});
