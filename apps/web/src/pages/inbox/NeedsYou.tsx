/**
 * "Needs you" (`docs/design/HANDOFF.md` → Home; OPS-02, CHT-09, #40): the
 * rows a person must answer, approvals first, then input, then interrupted,
 * oldest first inside each kind. An approval row carries the `ai-approval`
 * card wired to `Session.respond` with `once` | `session` scope; an input
 * row an answer box; every row links to where it came from. The card's
 * data is the Session's record, so a decision from any client — this tab,
 * the chat, the phone — collapses the card here and the row leaves the
 * list once the Session marks the notification read.
 */
import { component } from 'sigx';
import type { Decision } from '@sigx/ai-agent';
import type { OpenRequest } from '@sigx/ai-agent/app';
import { AgentTile, ApprovalPrompt, Button, EmptyState, EnvironmentLine, NeedsItem, SectionHeading, type ApprovalDecision } from '@agentic/ui';
import type { SessionRequestView } from '@agentic/platform';
import { LinkButton } from '../ops/LinkButton';
import { sortRows, type NeedsRow, type NeedsSource, type RequestState } from './source';

/** The Session's request as the card takes it. */
export function openRequestOf(view: SessionRequestView): OpenRequest {
    const r = view.request;
    return {
        requestId: r.requestId,
        kind: r.kind,
        seq: r.seq,
        ...(r.turnId ? { turnId: r.turnId } : {}),
        ...(r.callId ? { callId: r.callId } : {}),
        ...(r.toolName ? { toolName: r.toolName } : {}),
        ...(r.message ? { message: r.message } : {}),
        ...(r.options ? { options: r.options } : {}),
        ...(r.schema ? { schema: r.schema } : {}),
        ...(r.permissionKey ? { permissionKey: r.permissionKey } : {})
    };
}

/** The collapsed record of a settled permission request: who decided, from where. */
export function decisionOf(view: SessionRequestView, from?: string): ApprovalDecision | undefined {
    const r = view.resolved;
    if (!r || (r.outcome !== 'allow' && r.outcome !== 'deny')) return undefined;
    return { outcome: r.outcome, scope: r.scope ?? 'once', by: r.by === 'client' ? 'you' : r.by, ...(from ? { from } : {}) };
}

/** Where a row leads: the chat it belongs to, else its task, else the session. */
export function hrefOf(row: NeedsRow, view?: SessionRequestView): { readonly to: string; readonly label: string } {
    if (row.href && row.hrefLabel) return { to: row.href, label: row.hrefLabel };
    if (view?.chatId) return { to: `/chats/${view.chatId}`, label: 'Open chat' };
    if (view?.taskId) return { to: `/tasks/${view.taskId}`, label: 'Open task' };
    return { to: `/sessions/${row.ref?.sessionId ?? view?.sessionId ?? ''}`, label: 'Open session' };
}

const NeedsRowView = component<{ row: NeedsRow; source: NeedsSource }>(({ props, signal }) => {
    const row = props.row;
    const source = props.source;
    const request: (() => RequestState) | undefined = row.ref ? source.useRequest(row.ref) : undefined;
    const st = signal({ answer: '', busy: false, error: '' });

    const respond = async (decision: Decision): Promise<void> => {
        if (!row.ref) return;
        st.busy = true;
        st.error = '';
        try {
            await source.respond(row.ref, decision);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            st.busy = false;
        }
    };

    const answer = (): void => {
        const text = st.answer.trim();
        if (!text) return;
        void respond({ type: 'input', answers: text }).then(() => {
            st.answer = '';
        }, () => undefined);
    };

    return () => {
        const r = request?.();
        const view = r?.value ?? null;
        const who = view?.requestedBy ?? row.agent;
        const env = view?.environment ?? row.environment;
        const link = hrefOf(row, view?.view);
        const resolved = view?.view.resolved;
        return (
            <NeedsItem kind={row.kind} title={row.title} age={source.age(row.at)} slots={{
                tile: () => (who ? <AgentTile name={who.name} hue={who.hue} size={32} /> : null),
                context: () => (
                    <>
                        {env ? <EnvironmentLine tone="dim" {...env} /> : null}
                        {row.context ? <span>{row.context}</span> : null}
                    </>
                )
            }}>
                {row.kind === 'approval' && view ? (
                    <ApprovalPrompt
                        request={openRequestOf(view.view)}
                        input={view.view.input}
                        rule={view.view.rule}
                        requestedBy={view.requestedBy}
                        environment={view.environment}
                        via={view.via}
                        decision={decisionOf(view.view)}
                        onRespond={(_, decision) => respond(decision)}
                    />
                ) : null}
                {row.kind === 'input' && view ? (
                    resolved ? (
                        <p data-needs-answered>{`Answered${resolved.outcome === 'cancel' ? ' (cancelled)' : ''}`}</p>
                    ) : (
                        <div data-needs-answer>
                            {view.view.request.message ? <p data-needs-question>{view.view.request.message}</p> : null}
                            <textarea aria-label="Your answer" rows={2} value={st.answer} disabled={st.busy} onInput={(e: Event) => { st.answer = (e.target as HTMLTextAreaElement).value; }} />
                            <Button intent="wait" loading={st.busy} disabled={st.busy || !st.answer.trim()} onClick={answer}>Answer</Button>
                        </div>
                    )
                ) : null}
                {row.kind === 'interrupted' && row.primary ? <Button intent="wait" icon="play">{row.primary.label}</Button> : null}
                {r?.loading && !view ? <p data-panel-note>Loading the request…</p> : null}
                {r?.error ? <p data-needs-error role="alert">{`Could not load the request: ${r.error.message}`}</p> : null}
                {st.error && row.kind !== 'approval' ? <p data-needs-error role="alert">{`Could not answer: ${st.error}`}</p> : null}
                <LinkButton to={link.to} label={link.label}>{link.label}</LinkButton>
            </NeedsItem>
        );
    };
});

/** The section: heading with the open count, the rows, or the inbox empty state. */
export const NeedsYou = component<{ source: NeedsSource }>(({ props }) => {
    const rows = props.source.useRows();
    return () => {
        const sorted = sortRows(rows());
        return (
            <section data-home-needs aria-label="Needs you">
                <SectionHeading count={`${sorted.length} open`} slots={{ aside: () => 'answer here, in the chat, or on your phone' }}>Needs you</SectionHeading>
                {sorted.length
                    ? <div data-needs-list>{sorted.map((row) => <div key={row.id} data-needs-row><NeedsRowView row={row} source={props.source} /></div>)}</div>
                    : <EmptyState variant="inbox" />}
            </section>
        );
    };
});
