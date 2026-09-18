import { component, type Define, type JSXElement } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { AgentTile, ApprovalPrompt, Button, EmptyState, EnvironmentLine, EventsLostRow, Icon, StatusPill, ToolCall, type RespondFn } from '@agentic/ui';
import { KeyValue } from '../components/KeyValue';
import { FailureNotice, failureOf } from '../components/status';
import { Page } from '../components/Page';
import { Panel } from '../components/Panel';
import { defineTopbar, routeId } from '../components/topbar';
import { agentNamed, CAPABILITY_LABELS, formatTime, loadSession, taskRow, type MockSessionView } from '../mock/workspace';
import { dataMode } from '../data-mode';
import { LiveSession, sessionHead } from './session/LiveSession';
import { sessionSignals } from './session/live';
import type { AgentIdentity } from './chat/live';

const sessionPill = (s: MockSessionView): string => {
    switch (s.state) {
        case 'running': return 'active';
        case 'awaiting': return 'waiting';
        case 'disconnected': return 'disconnected';
        case 'error': return 'error';
        case 'closed': return 'completed';
        default: return s.interrupted ? 'interrupted' : 'queued';
    }
};

defineTopbar('session', (route) => {
    const id = routeId(route);
    // Live: what the page published for THIS session (`session/LiveSession.tsx`); mock: the workspace's view.
    const v = dataMode() === 'live' ? (sessionHead.value?.id === id ? sessionHead.value.view : undefined) : loadSession(id);
    return {
        crumb: v?.ref,
        actions: () => (v ? (
            <>
                {v.capabilities.cancel && (v.state === 'running' || v.state === 'awaiting') ? <Button intent="default" icon="stop" onClick={() => sessionHead.value?.cancel()}>Cancel turn</Button> : null}
                {v.state !== 'closed' ? <Button intent="danger" icon="close" onClick={() => sessionHead.value?.close()}>Close session</Button> : null}
            </>
        ) : null)
    };
});

/**
 * `/sessions/:id` — the current tool call, the compact approval, the event
 * log; execution, capabilities and grants on the right. Controls for
 * unsupported operations are not rendered at all (AC-15): the capability
 * list drives them, never agent identity.
 */
export const Session = component(() => {
    const route = useRoute();
    const view = () => loadSession(String(route.params.id));
    return () => {
        if (dataMode() === 'live') return <LiveSession id={String(route.params.id)} />;
        const v = view();
        if (!v) {
            return (
                <Page title="Session not found">
                    <EmptyState variant="generic" title="No session with that id" caption={`Nothing is called ${String(route.params.id)}.`} slots={{ actions: () => <Link to="/">Back home</Link> }} />
                </Page>
            );
        }
        return <SessionView v={v} agent={agentNamed(v.agentId)} />;
    };
});

export type SessionViewProps =
    & Define.Prop<'v', MockSessionView, true>
    & Define.Prop<'agent', AgentIdentity, true>
    & Define.Prop<'onRespond', RespondFn>
    /** "Resume" on an interrupted turn (OPS-05). */
    & Define.Prop<'onResume', () => void>
    & Define.Prop<'recovering', boolean>
    /** `14:02` for the header; default: the mock workspace's zone. The live page passes the workspace's (`time.ts`). */
    & Define.Prop<'time', (ms: number) => string>
    /** Revoke one session grant. Absent — as everywhere today: the platform lists grants, it cannot revoke them — no control is drawn (AC-15). */
    & Define.Prop<'onRevoke', (key: string) => void>;

/** The page body over a resolved view — the mock workspace's, or the live session's (#34). */
export const SessionView = component<SessionViewProps>(({ props }) => {
    return (): JSXElement => {
        const { v, agent } = props;
        const supported = new Set(v.capabilities.supported);
        const ops = [...v.capabilities.supported, ...v.capabilities.unsupported.map((u) => u.op)];
        const reason = (op: string) => v.capabilities.unsupported.find((u) => u.op === op)?.reason;
        // One named failure from the session's signals (OPS-04), never a generic error; interrupted work is marked uncertain (OPS-05).
        const failure = failureOf(sessionSignals(v));
        return (
            <Page title={`Session ${v.ref}`} page="session" hideTitle>
                <header data-session-head>
                    <AgentTile name={agent.name} hue={agent.hue} size={44} />
                    <div data-session-title>
                        <span data-session-id>Session {v.ref}</span>
                        <span data-session-sub>{v.openedAt ? `Opened ${(props.time ?? formatTime)(v.openedAt)} from ${v.openedFrom}` : `Opened from ${v.openedFrom}`}</span>
                    </div>
                    <StatusPill status={sessionPill(v)} />
                    <EnvironmentLine tone="muted" {...v.environment} />
                </header>

                <section data-session-main aria-label="Session activity">
                    {failure ? <FailureNotice state={failure} {...(props.onResume ? { onResume: props.onResume } : {})} busy={props.recovering ?? false} /> : null}
                    {v.current ? <ToolCall part={v.current.part} transcript={v.current.transcript} {...(v.current.meta ? { meta: v.current.meta } : {})} /> : null}
                    {v.request ? <ApprovalPrompt request={v.request.request} {...v.request.context} compact onRespond={(id, d) => props.onRespond?.(id, d)} /> : null}
                    <Panel label="Event log · tail" slots={{ aside: () => (v.state === 'running' || v.state === 'awaiting' ? <StatusPill status="live" /> : null) }}>
                        <ol data-event-log aria-label="Event log">
                            {v.events.map((e) => (
                                <>
                                    {v.gap && e.seq === v.gap.to ? <EventsLostRow as="li" from={v.gap.from} to={v.gap.to} /> : null}
                                    <li data-event data-kind={e.kind}>
                                        <span data-event-seq>{e.seq}</span>
                                        <span data-event-kind>{e.kind}</span>
                                        <span data-event-text>{e.text}</span>
                                    </li>
                                </>
                            ))}
                        </ol>
                    </Panel>
                </section>

                <aside data-session-rail aria-label="Execution and capabilities">
                    <Panel label="Execution" slots={{ aside: () => (v.state === 'awaiting' ? <StatusPill status="waiting" label="AWAITING" /> : <StatusPill status={v.state} />) }}>
                        <KeyValue labelWidth={96} rows={[
                            { label: 'Agent', value: () => <span data-inline-tile><AgentTile name={agent.name} hue={agent.hue} size={18} /> {agent.name} · config v{v.configVersion}</span> },
                            { label: 'Machine', value: () => `${v.machine.name} · ${v.machine.os}` },
                            { label: 'Runtime', value: () => v.runtimeVersion },
                            { label: 'Account', value: () => <span data-inline-tile>{v.environment.account} <StatusPill status={v.authStatus} /></span> },
                            // A platform session runs in no directory: the row is left out, not dashed.
                            ...(v.cwd ? [{ label: 'Working dir', value: () => <code>{v.cwd}</code> }] : []),
                            { label: 'Head', value: () => `epoch ${v.head.epoch} · seq ${v.head.seq}` },
                            { label: 'Task', value: () => (v.taskId ? <Link to={`/tasks/${v.taskId}`}>{taskRow(v.taskId)?.ref ?? v.taskId}</Link> : '—') }
                        ]} />
                    </Panel>
                    <Panel label="What this integration supports">
                        <ul data-capabilities>
                            {ops.map((op) => {
                                const ok = supported.has(op);
                                const spec = CAPABILITY_LABELS[op] ?? { label: op };
                                return (
                                    <li data-capability data-supported={ok ? 'true' : 'false'}>
                                        <Icon name={ok ? 'check' : 'close'} size={14} />
                                        <span data-capability-label>{spec.label}</span>
                                        <span data-capability-note>{ok ? spec.note : reason(op)}</span>
                                    </li>
                                );
                            })}
                        </ul>
                        <p data-panel-note>Unsupported operations are hidden from controls, never faked.</p>
                    </Panel>
                    <Panel label="Session grants">
                        {v.grants.length ? (
                            <ul data-grants>
                                {v.grants.map((g) => (
                                    <li data-grant>
                                        <code>{g.label}</code>
                                        {props.onRevoke ? <Button intent="default" onClick={() => props.onRevoke?.(g.key)}>Revoke</Button> : null}
                                    </li>
                                ))}
                            </ul>
                        ) : <p data-panel-note>No session-scoped grants.</p>}
                        {v.grants.length ? <p data-panel-note data-grants-note>Grants end with the session.</p> : null}
                    </Panel>
                </aside>
            </Page>
        );
    };
});
