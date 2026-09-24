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
 *
 * Plan mode's way out (#454) is the same card with other words: the plan as
 * markdown, `Approve · default` / `Approve · accept edits` — an allow that
 * names the permission mode the member goes on in — and `Keep planning`, a
 * deny that tells the model to revise. The well shows the plan at the
 * card's size; `Open plan` reads it full-size in a `MarkdownDialog` (#490)
 * with the same three answers in its footer.
 */
import { component, type Define, type JSXElement } from '@sigx/runtime-core';
import type { Decision, OpenRequest } from '@sigx/ai-agent/app';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { EnvironmentLine, type EnvironmentParts } from '../kit/EnvironmentLine.js';
import { ErrorNote } from '../kit/ErrorNote.js';
import { Icon } from '../kit/icons.js';
import { MarkdownDialog } from '../kit/MarkdownDialog.js';
import { MarkdownViewer, type MarkdownViewerProps } from '../kit/MarkdownViewer.js';
import { aiApprovalAnatomy } from './anatomy.js';
import { nonBlank, signature } from './text.js';

const SCOPE = aiApprovalAnatomy.scope;

/**
 * How a decision leaves the card — `session.respond()` in some form. A
 * returned promise is awaited: while it is out the buttons stay disabled,
 * a rejection re-enables them and shows its message (the request is still
 * open; the user tries again), a resolution leaves them disabled until the
 * caller passes the `decision` the session recorded — which may come from
 * another client altogether (OPS-02).
 */
export type RespondFn = (requestId: string, decision: Decision, options?: RespondOptions) => unknown;

/** What an answer asks for beside the decision: the permission mode an approved plan goes on in (#454). */
export interface RespondOptions {
    readonly permissionMode?: string;
}

/** Claude Code's tool that ends plan mode (#454); its input's `plan` is the plan, in markdown. */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/** The plan an `ExitPlanMode` call carries, when it carries one. */
export function planOf(input: unknown): string | undefined {
    const plan = typeof input === 'object' && input !== null ? (input as { plan?: unknown }).plan : undefined;
    return typeof plan === 'string' && plan.trim() ? plan : undefined;
}

/** What "Keep planning" tells the model. */
export const KEEP_PLANNING_MESSAGE = 'The operator wants you to keep planning: revise the plan before asking again.';

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
    & Define.Prop<'decision', ApprovalDecision, false>
    /** The plan dialog's code highlighter; `false` keeps code plain (tests). */
    & Define.Prop<'highlighter', MarkdownViewerProps['highlighter'], false>;

export const DENY_MESSAGE = 'The operator denied this call.';

/** The modes an approved plan can go on in, as the card offers them. */
const PLAN_MODES = [
    { mode: 'default', label: 'Approve · default' },
    { mode: 'acceptEdits', label: 'Approve · accept edits' }
] as const;

/** The one-line record of a decision. */
export function decisionText(d: ApprovalDecision): string {
    const what = d.outcome === 'allow' ? (d.scope === 'session' ? 'Allowed for session' : 'Allowed once') : 'Denied';
    const by = d.by ? ` by ${d.by}` : '';
    const from = d.from ? ` from ${d.from}` : '';
    return `${what}${by}${from}`;
}

export const ApprovalPrompt = component<ApprovalPromptProps>(({ props, signal }) => {
    /**
     * The button that was clicked, until the request resolves or the caller passes the decision; `error` when the
     * answer did not get through; `open` while the plan is read full-size (#490).
     */
    const st = signal({ pending: undefined as string | undefined, error: '', open: false });

    /** `mode`: a plan approved into that permission mode (#454); `message`: what a deny tells the model. */
    const decide = (outcome: 'allow' | 'deny', scope: 'once' | 'session', plan?: { readonly mode?: string; readonly message?: string }): void => {
        if (st.pending) return;
        st.pending = plan?.mode ?? (outcome === 'deny' ? 'deny' : scope);
        st.error = '';
        st.open = false;
        let out: unknown;
        try {
            out = props.onRespond(
                props.request.requestId,
                {
                    type: 'permission',
                    outcome,
                    scope,
                    ...(outcome === 'deny' ? { message: plan?.message ?? DENY_MESSAGE } : {})
                },
                ...(plan?.mode ? [{ permissionMode: plan.mode }] : [])
            );
        } catch (e) {
            failed(e);
            return;
        }
        if (out && typeof (out as Promise<unknown>).then === 'function') void (out as Promise<unknown>).then(undefined, failed);
    };

    /** The answer never reached the session: say so and let the user try again. */
    const failed = (e: unknown): void => {
        st.pending = undefined;
        st.error = e instanceof Error ? e.message : String(e);
    };

    /** The plan's three answers — in the card's action row and again in the dialog's footer (#490). */
    const planActions = (): JSXElement[] => {
        const busy = st.pending !== undefined;
        return [
            ...PLAN_MODES.map((m, i) => (
                <Button intent={i === 0 ? 'wait' : 'default'} icon={i === 0 ? 'check' : undefined} loading={st.pending === m.mode} disabled={busy} onClick={() => decide('allow', 'once', { mode: m.mode })}>
                    {m.label}
                </Button>
            )),
            <Button intent="danger" icon="close" loading={st.pending === 'deny'} disabled={busy} onClick={() => decide('deny', 'once', { message: KEEP_PLANNING_MESSAGE })}>
                Keep planning
            </Button>
        ];
    };

    return () => {
        const request = props.request;
        const name = request.toolName ?? props.toolName ?? 'this tool';
        const plan = name === EXIT_PLAN_MODE_TOOL ? (planOf(props.input) ?? planOf((request as { input?: unknown }).input) ?? '') : undefined;
        const why = nonBlank(request.message);
        const sig = signature(props.input);
        const rule = nonBlank(props.rule);
        const who = props.requestedBy;
        const env = props.environment;
        const via = nonBlank(props.via);
        const context = !props.compact && (who || env || via);
        const decision = props.decision;
        const busy = st.pending !== undefined;
        // A written plan, still open: readable full-size.
        const readable = !!plan && !decision;
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
                    <span data-scope={SCOPE} data-part="title">{plan !== undefined ? (decision ? 'Plan' : 'Plan ready for review') : decision ? 'Approval' : 'Approval needed'}</span>
                    {rule && <span data-scope={SCOPE} data-part="rule">{`rule: ${rule}`}</span>}
                    {readable && <Button intent="icon" icon="expand" label="Open plan" onClick={() => { st.open = true; }} />}
                </div>
                {plan !== undefined ? (
                    !decision && (
                        <div data-scope={SCOPE} data-part="plan">
                            {plan ? <MarkdownViewer value={plan} compact highlighter={props.highlighter} /> : <p>The agent asks to leave plan mode without a written plan.</p>}
                        </div>
                    )
                ) : (
                    <div data-scope={SCOPE} data-part="request">
                        <code>{name}</code>
                        {sig && <span>{sig}</span>}
                    </div>
                )}
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
                {st.error && !decision ? <ErrorNote data-approval-error="">{`Could not answer: ${st.error}`}</ErrorNote> : null}
                {decision ? (
                    <p data-scope={SCOPE} data-part="record">{decisionText(decision)}</p>
                ) : plan !== undefined ? (
                    <div data-scope={SCOPE} data-part="actions">{planActions()}</div>
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
                {readable && (
                    <MarkdownDialog model={() => st.open} title="Plan" value={plan} highlighter={props.highlighter} slots={{ footer: planActions }} />
                )}
            </div>
        );
    };
}, { name: 'ApprovalPrompt' });
