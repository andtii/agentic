/**
 * The live session view (#34): `Session.get()` and its event log, folded
 * into the shape the session page draws (`MockSessionView`) — execution
 * facts from the spec, the current tool call and open request from a
 * transcript folded over the log, the event log itself summarised one
 * line per event, the capability report from what the runtime declared
 * (AC-15: unsupported operations are listed, their controls never drawn).
 *
 * Nothing here is a literal (#154): the open time is the instant `open`
 * stamped on the spec (`retrieval.at`, present when the platform has its
 * learning ports — 0 otherwise, and the header says only where it was opened
 * from), the working dir is the environment's first `cwdRoots` entry — what
 * the router hands the daemon — and empty for a platform session, and the
 * current tool call carries no duration: agent events have no timestamps.
 */
import type { CapabilityReport, MachineId, RuntimeId, SessionId, TaskId } from '@agentic/core';
import type { MachineView, SessionInfo } from '@agentic/platform';
import { createTranscript, reduceAgentEvent, type AgentEvent } from '@sigx/ai-agent';
import type { ToolPartState } from '@sigx/ai-agent/app';
import type { ApprovalContext } from '@agentic/ui';
import type { FailureSignals } from '../../components/status';
import type { MockEvent, MockSessionView } from '../../mock/workspace';
import type { AgentIdentity } from '../chat/live';

const PLATFORM_MACHINE = { id: 'platform' as MachineId, name: 'platform', os: 'Cloudflare', online: true } as const;

/** Most log lines shown; the log is a tail. */
export const LOG_TAIL = 60;

const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const brief = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return clip(v.replace(/\s+/g, ' ').trim());
    try {
        return clip(JSON.stringify(v));
    } catch {
        return clip(String(v));
    }
};

/** The log, one line per event that says something (deltas fold into their part's line). */
export function eventLines(events: readonly AgentEvent[]): MockEvent[] {
    const out: MockEvent[] = [];
    const text = new Map<string, string>();
    const partSeq = new Map<string, number>();
    for (const ev of events) {
        switch (ev.type) {
            case 'part-start':
                text.set(ev.partId, '');
                partSeq.set(ev.partId, ev.seq);
                break;
            case 'part-delta':
                text.set(ev.partId, (text.get(ev.partId) ?? '') + ev.delta);
                break;
            case 'part-end': {
                const t = text.get(ev.partId) ?? '';
                if (t.trim()) out.push({ seq: partSeq.get(ev.partId) ?? ev.seq, kind: 'text', text: brief(t) });
                text.delete(ev.partId);
                partSeq.delete(ev.partId);
                break;
            }
            case 'tool-call':
                out.push({ seq: ev.seq, kind: 'tool-call', text: `${ev.name} ${brief(ev.input)}`.trim() });
                break;
            case 'tool-update':
                out.push({ seq: ev.seq, kind: 'tool-result', text: ev.error ? `${ev.status} ${brief(ev.error)}` : ev.output !== undefined ? brief(ev.output) : ev.status });
                break;
            case 'request':
                out.push({ seq: ev.seq, kind: 'request', text: `${ev.kind} ${ev.requestId}${ev.permissionKey ? ` ${ev.permissionKey}` : ''}` });
                break;
            case 'turn-end':
                out.push({ seq: ev.seq, kind: 'turn-end', text: ev.error ? `${ev.stopReason} · ${ev.error.message}` : ev.stopReason });
                break;
            case 'error':
                out.push({ seq: ev.seq, kind: 'error', text: `${ev.code}: ${ev.message}` });
                break;
            default:
                break;
        }
    }
    // A part still streaming shows as it stands.
    for (const [partId, t] of text) if (t.trim()) out.push({ seq: partSeq.get(partId) ?? 0, kind: 'text', text: brief(t) });
    return out.slice(-LOG_TAIL);
}

/** What the runtime declared → the report the page lists (AC-15). */
export function capabilityReport(runtime: RuntimeId, caps: SessionInfo['capabilities']): CapabilityReport {
    const supported: string[] = [];
    const unsupported: { op: string; reason: string }[] = [];
    const say = (op: string, ok: boolean, reason: string): void => { if (ok) supported.push(op); else unsupported.push({ op, reason }); };
    if (!caps) {
        return { runtime, supported: [], unsupported: [{ op: 'resume', reason: 'not reported yet' }, { op: 'cancel', reason: 'not reported yet' }, { op: 'approvals', reason: 'not reported yet' }, { op: 'steer', reason: 'not reported yet' }, { op: 'usage', reason: 'not reported yet' }, { op: 'migrate', reason: 'not supported' }], resume: false, cancel: false, steer: false, permissions: 'none', tools: 'none' };
    }
    say('resume', caps.resume !== false, 'the runtime cannot resume a session');
    say('cancel', caps.cancel, 'the runtime cannot cancel a turn');
    say('approvals', caps.permissions !== 'none', 'the runtime asks no permission');
    say('steer', caps.steer, 'the model runs one turn at a time');
    say('usage', runtime === 'anthropic-api', 'not reported by provider');
    say('migrate', false, 'not supported');
    return { runtime, supported, unsupported, resume: caps.resume, cancel: caps.cancel, steer: caps.steer, permissions: caps.permissions, tools: caps.tools };
}

/** The interrupted marker the Session actor writes for a turn an eviction cut short (OPS-05). */
export const isInterruptedEnd = (ev: AgentEvent): boolean => ev.type === 'turn-end' && ev.stopReason === 'error' && ev.error?.code === 'process_exited';

/** The pill's word for an environment account's `authStatus`; `unknown` shows as ok until the daemon says otherwise. */
const authPillOf = (status: MachineView['environments'][number]['account']['authStatus']): MockSessionView['authStatus'] => (status === 'missing' ? 'auth-missing' : status === 'expired' ? 'auth-expired' : 'auth-ok');

/**
 * The failure signals a session view carries (OPS-04): the machine's
 * presence, the account's auth status, the session's state, its last
 * non-recoverable error and the interrupted marker. `failureOf` picks one.
 */
export function sessionSignals(v: MockSessionView): FailureSignals {
    return {
        machine: v.machine.id === 'platform' ? null : { id: v.machine.id, name: v.machine.name, online: v.machine.online },
        auth: v.auth ?? null,
        session: { status: v.state, ...(v.error ? { error: v.error } : {}), ...(v.interrupted ? { interrupted: true } : {}) },
        ...(v.taskId ? { task: { id: v.taskId, status: 'active' } } : {})
    };
}

/**
 * `Session.get()`, its log and — for a daemon session — its machine's record
 * (`Machine.online`, the environment's account) folded into the page view.
 */
export function liveSessionView(id: string, info: SessionInfo, events: readonly AgentEvent[], agent: AgentIdentity, machine?: MachineView): MockSessionView {
    const spec = info.spec;
    const runtime = spec?.runtime ?? ('anthropic-api' as RuntimeId);
    const transcript = createTranscript(id);
    for (const ev of events) reduceAgentEvent(transcript, ev);
    const tools = transcript.messages.flatMap((m) => m.parts.filter((p): p is ToolPartState => p.type === 'tool'));
    const running = [...tools].reverse().find((p) => p.status === 'in_progress' || p.status === 'pending');
    const open = Object.values(transcript.requests).sort((a, b) => a.seq - b.seq)[0];
    const context: ApprovalContext | undefined = open
        ? { toolName: open.toolName ?? '', input: open.message ?? '', requestedBy: { name: agent.name, hue: agent.hue }, environment: agent.environment, compact: true }
        : undefined;
    const last = events[events.length - 1];
    const model = spec?.config.execution.model;
    const env = machine?.environments.find((e) => e.id === spec?.environmentId);
    const error = transcript.error && !transcript.error.recoverable ? { code: transcript.error.code, message: transcript.error.message, recoverable: false } : undefined;
    return {
        id: id as SessionId,
        ref: info.ref?.id ?? id,
        agentId: spec?.agentId ?? agent.id,
        state: info.status,
        openedAt: spec?.retrieval?.at ?? 0,
        openedFrom: spec?.chatId ? `chat ${spec.chatId}` : spec?.taskId ? `task ${spec.taskId}` : 'the platform',
        ...(spec?.chatId ? { chatId: spec.chatId } : {}),
        ...(spec?.taskId ? { taskId: spec.taskId as TaskId } : {}),
        environment: agent.environment,
        machine: spec?.machineId
            ? { id: spec.machineId, name: machine?.name ?? spec.machineId, os: machine?.os ?? '—', online: machine ? machine.online : info.status !== 'disconnected' }
            : PLATFORM_MACHINE,
        runtimeVersion: model ? `${runtime} · ${model}` : runtime,
        authStatus: env ? authPillOf(env.account.authStatus) : 'auth-ok',
        ...(env ? { auth: { status: env.account.authStatus, account: env.account.label } } : {}),
        ...(error ? { error } : {}),
        cwd: env?.cwdRoots[0] ?? '',
        head: info.head,
        configVersion: spec?.config.configVersion ?? agent.configVersion,
        ...(running ? { current: { part: running, transcript } } : {}),
        ...(open && context ? { request: { request: open, context } } : {}),
        events: eventLines(events),
        ...(info.gap ? { gap: { from: info.gap.from.seq, to: info.gap.resumeAt.seq } } : {}),
        capabilities: capabilityReport(runtime, info.capabilities),
        grants: transcript.grants.map((key) => ({ key, label: key.replace(':', '  ') })),
        ...(last && isInterruptedEnd(last) ? { interrupted: true } : {})
    };
}
