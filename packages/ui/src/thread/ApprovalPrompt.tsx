/**
 * `ApprovalPrompt` — an open permission request as the handoff's approval
 * card (`ai-approval`, `docs/design/HANDOFF.md` → "Approvals"): a header
 * with the shield, "Approval needed" and the matching rule in mono; the
 * request well with the tool and its input verbatim; the context rows
 * (Requested by, Runs on, Via) that `compact` drops; and three decisions —
 * `Allow once` (amber), `Allow for this session`, `Deny`. It is one
 * component everywhere: under the message that raised it, in the Home
 * inbox, on the Task and Session pages, on mobile.
 *
 * The decision goes out exactly as `session.respond()` takes it: a
 * `session`-scoped allow is remembered under the request's `permissionKey`,
 * so the same call is never asked twice; a deny carries a message the model
 * reads. Between the click and the ack the buttons disable and the chosen
 * one spins; once the caller passes a `decision` the card collapses to the
 * one-line `record` (who decided, which scope, from which client).
 */
import { component, type Define } from '@sigx/runtime-core';
import type { Decision, OpenRequest } from '@sigx/ai-agent/app';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { EnvironmentLine, type EnvironmentParts } from '../kit/EnvironmentLine.js';
import { Icon } from '../kit/icons.js';
import { aiApprovalAnatomy } from './anatomy.js';
import { nonBlank, signature } from './text.js';

const SCOPE = aiApprovalAnatomy.scope;

export type RespondFn = (requestId: string, decision: Decision) => void;

/** Who is asking — the agent's name and identity slot. */
export interface ApprovalRequester {
    readonly name: string;
    readonly hue?: AgentHue;
}

/** A settled request, for the collapsed record: "Allowed for session by Andii from phone". */
export interface ApprovalDecision {
    readonly outcome: 'allow' | 'deny';
    readonly scope: 'once' | 'session';
    /** Who decided — a person's name, or `policy`. */
    readonly by?: string;
    /** Which client — `phone`, `chat`, `inbox`. */
    readonly from?: string;
}

export type ApprovalPromptProps =
    & Define.Prop<'request', OpenRequest, true>
    & Define.Prop<'onRespond', RespondFn, true>
    /** The tool's name when the request carries none (a card knows its part). */
    & Define.Prop<'toolName', string, false>
    /** The call's input, shown verbatim in the request well. */
    & Define.Prop<'input', unknown, false>
    /** The matching policy rule — `ask on destructive`. */
    & Define.Prop<'rule', string, false>
    & Define.Prop<'requestedBy', ApprovalRequester, false>
    & Define.Prop<'environment', EnvironmentParts, false>
    /** How the request got here — `delegated by Atlas · task t_8f2c · depth 1`. */
    & Define.Prop<'via', string, false>
    /** Session page and mobile: no context rows. */
    & Define.Prop<'compact', boolean, false>
    /** A decision that arrived (from this or another client): the card collapses to its record. */
    & Define.Prop<'decision', ApprovalDecision, false>;

export const DENY_MESSAGE = 'The operator denied this call.';

/** The one-line record of a decision. */
export function decisionText(d: ApprovalDecision): string {
    const what = d.outcome === 'allow' ? (d.scope === 'session' ? 'Allowed for session' : 'Allowed once') : 'Denied';
    const by = d.by ? ` by ${d.by}` : '';
    const from = d.from ? ` from ${d.from}` : '';
    return `${what}${by}${from}`;
}

export const ApprovalPrompt = component<ApprovalPromptProps>(({ props, signal }) => {
    /** The button that was clicked, until the request resolves or the caller passes the decision. */
    const st = signal({ pending: undefined as 'once' | 'session' | 'deny' | undefined });

    const decide = (outcome: 'allow' | 'deny', scope: 'once' | 'session'): void => {
        if (st.pending) return;
        st.pending = outcome === 'deny' ? 'deny' : scope;
        props.onRespond(props.request.requestId, {
            type: 'permission',
            outcome,
            scope,
            ...(outcome === 'deny' ? { message: DENY_MESSAGE } : {})
        });
    };

    return () => {
        const request = props.request;
        const name = request.toolName ?? props.toolName ?? 'this tool';
        const why = nonBlank(request.message);
        const sig = signature(props.input);
        const rule = nonBlank(props.rule);
        const who = props.requestedBy;
        const env = props.environment;
        const via = nonBlank(props.via);
        const context = !props.compact && (who || env || via);
        const decision = props.decision;
        const busy = st.pending !== undefined;
        return (
            <div
                data-scope={SCOPE}
                data-part="root"
                data-mod-compact={props.compact ? '' : undefined}
                role="group"
                aria-label={`Approval needed${who ? ` from ${who.name}` : ''}: ${name}${sig ? ` ${sig}` : ''}`}
                aria-live={decision ? undefined : 'assertive'}
            >
                <div data-scope={SCOPE} data-part="header">
                    <Icon name="shield" size={15} />
                    <span data-scope={SCOPE} data-part="title">{decision ? 'Approval' : 'Approval needed'}</span>
                    {rule && <span data-scope={SCOPE} data-part="rule">{`rule: ${rule}`}</span>}
                </div>
                <div data-scope={SCOPE} data-part="request">
                    <code>{name}</code>
                    {sig && <span>{sig}</span>}
                </div>
                {why && <p data-scope={SCOPE} data-part="description">{why}</p>}
                {context && (
                    <dl data-scope={SCOPE} data-part="context">
                        {who && (
                            <>
                                <dt>Requested by</dt>
                                <dd>
                                    <AgentTile name={who.name} hue={who.hue} size={20} />
                                    <strong>{who.name}</strong>
                                </dd>
                            </>
                        )}
                        {env && (
                            <>
                                <dt>Runs on</dt>
                                <dd>
                                    <EnvironmentLine machine={env.machine} runtime={env.runtime} account={env.account} tone="live" />
                                </dd>
                            </>
                        )}
                        {via && (
                            <>
                                <dt>Via</dt>
                                <dd>{via}</dd>
                            </>
                        )}
                    </dl>
                )}
                {decision ? (
                    <p data-scope={SCOPE} data-part="record">{decisionText(decision)}</p>
                ) : (
                    <div data-scope={SCOPE} data-part="actions">
                        <Button intent="wait" icon="check" loading={st.pending === 'once'} disabled={busy} onClick={() => decide('allow', 'once')}>
                            Allow once
                        </Button>
                        <Button intent="default" label="Allow for this session" loading={st.pending === 'session'} disabled={busy} onClick={() => decide('allow', 'session')}>
                            <span data-scope={SCOPE} data-part="label-full">Allow for this session</span>
                            <span data-scope={SCOPE} data-part="label-short" aria-hidden="true">Allow for session</span>
                        </Button>
                        <Button intent="danger" icon="close" loading={st.pending === 'deny'} disabled={busy} onClick={() => decide('deny', 'once')}>
                            Deny
                        </Button>
                    </div>
                )}
            </div>
        );
    };
}, { name: 'ApprovalPrompt' });
