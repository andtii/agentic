/**
 * "Needs you" (`docs/design/HANDOFF.md` → Home; OPS-02, CHT-09, #40): the
 * rows a person must answer, approvals first, then input, then interrupted,
 * oldest first inside each kind. An approval row carries the `ai-approval`
 * card wired to `Session.respond` with `once` | `session` scope; an input
 * row the `ai-question` card (one block per question, the options as
 * toggles, free text beside them — answered in the form's own shape); an
 * interrupted row a Resume that goes through the router (`source.resume`, OPS-05); every row links to where it came from. The card's
 * data is the Session's record, so a decision from any client — this tab,
 * the chat, the phone — collapses the card here and the row leaves the
 * list once the Session marks the notification read.
 *
 * Pull requests join the list only when the next move is yours (PRJ-10,
 * #745): ready to merge, a review asked of you, conflicts to decide, or
 * autopilot stopped — as `PullCard`'s `home` item (`MERGE`, "Squash and
 * merge"), the same card and state as in the chat and on the task node. With
 * `pullSurface="notification"` (#951) the same PRs are Inbox rows instead:
 * `PullCard`'s `notification` surface (`agentic#603 needs you` and why), the
 * headline linked to the PR page, no merge button.
 */
import { component } from 'sigx';
import type { Decision } from '@sigx/ai-agent';
import type { PullRequest } from '@agentic/core';
import type { OpenRequest } from '@sigx/ai-agent/app';
import { AgentTile, ApprovalPrompt, Button, EmptyState, EnvironmentLine, ErrorNote, NeedsItem, PullCard, QuestionPrompt, SectionHeading, pullNeedsYou, type ApprovalDecision } from '@agentic/ui';
import type { SessionRequestView } from '@agentic/platform';
import { LinkButton } from '../ops/LinkButton';
import { MachineNotice } from '../machines/MachineNotice';
import { sortRows, type NeedsRow, type NeedsSource, type PlanApproval, type RequestState } from './source';
import { chatHref } from '../chat/href';

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
    if (view?.chatId) return { to: chatHref({ id: view.chatId }), label: 'Open chat' };
    if (view?.taskId) return { to: `/tasks/${view.taskId}`, label: 'Open task' };
    return { to: `/sessions/${row.ref?.sessionId ?? view?.sessionId ?? ''}`, label: 'Open session' };
}

const NeedsRowView = component<{ row: NeedsRow; source: NeedsSource }>(({ props, signal }) => {
    const row = props.row;
    const source = props.source;
    const request: (() => RequestState) | undefined = row.ref ? source.useRequest(row.ref) : undefined;
    const st = signal({ busy: false, error: '' });

    const respond = async (decision: Decision, plan?: PlanApproval): Promise<void> => {
        if (!row.ref) return;
        st.busy = true;
        st.error = '';
        try {
            await source.respond(row.ref, decision, plan);
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            st.busy = false;
        }
    };

    /** Resume an interrupted row; the row leaves with the live read once the route runs again. */
    const resume = (): void => {
        if (!source.resume || st.busy) return;
        st.busy = true;
        st.error = '';
        source.resume(row).catch((e: unknown) => {
            st.error = e instanceof Error ? e.message : String(e);
        }).finally(() => {
            st.busy = false;
        });
    };

    return () => {
        // A machine notice (#367) is its own row: a link to the machine and Dismiss, nothing to answer.
        if (row.kind === 'machine') {
            const dismiss = source.dismiss;
            if (!row.notice) return null;
            return <MachineNotice kind={row.notice.kind} title={row.title} body={row.notice.body} machineId={row.notice.machineId} age={source.age(row.at)} dismiss={dismiss ? () => dismiss(row) : undefined} />;
        }
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
                        onRespond={(_, decision, options) => respond(decision, options?.permissionMode ? { permissionMode: options.permissionMode, agentId: view.view.agentId, ...(view.view.chatId ? { chatId: view.view.chatId } : {}) } : undefined)}
                    />
                ) : null}
                {row.kind === 'input' && view ? (
                    <QuestionPrompt
                        request={openRequestOf(view.view)}
                        requestedBy={view.requestedBy}
                        stale={view.view.detached}
                        answered={resolved && resolved.outcome !== 'cancel' ? (resolved.answers ?? '') : undefined}
                        cancelled={resolved?.outcome === 'cancel'}
                        onRespond={(_, decision) => respond(decision)}
                    />
                ) : null}
                {row.kind === 'interrupted' && row.primary && source.resume ? <Button intent="wait" icon="play" loading={st.busy} disabled={st.busy || !!row.primary.disabled} onClick={resume}>{row.primary.label}</Button> : null}
                {r?.loading && !view ? <p data-panel-note>Loading the request…</p> : null}
                {r?.error ? <ErrorNote data-needs-error="">{`Could not load the request: ${r.error.message}`}</ErrorNote> : null}
                {st.error && row.kind === 'interrupted' ? <ErrorNote data-needs-error="">{`Could not resume: ${st.error}`}</ErrorNote> : null}
                <LinkButton to={link.to} label={link.label}>{link.label}</LinkButton>
            </NeedsItem>
        );
    };
});

/** The pull requests Home may list, and how it merges one; only those whose next move is yours show. */
export interface PullNeeds {
    /** Called in the list's setup: a reactive getter of the open pull requests. */
    usePulls(): () => readonly PullRequest[];
    /** Who is looking: a review requested from them is their move. */
    readonly me?: string;
    /** The PR page a card opens. */
    href?(pull: PullRequest): string | undefined;
    /** "Squash and merge"; rejects when the merge did not go through. */
    merge?(pull: PullRequest): Promise<void>;
}

/** The pull requests whose next move is yours, oldest first. */
export function pullsNeedingYou(pulls: readonly PullRequest[], me?: string): PullRequest[] {
    return pulls.filter((pr) => pullNeedsYou(pr, me)).sort((a, b) => a.openedAt - b.openedAt);
}

const PullRowView = component<{ pull: PullRequest; needs: PullNeeds }>(({ props, signal }) => {
    const st = signal({ busy: false, error: '' });
    const merge = (pull: PullRequest): void => {
        const run = props.needs.merge;
        if (!run || st.busy) return;
        st.busy = true;
        st.error = '';
        run(pull).catch((e: unknown) => {
            st.error = e instanceof Error ? e.message : String(e);
        }).finally(() => {
            st.busy = false;
        });
    };
    return () => (
        <>
            <PullCard pull={props.pull} surface="home" me={props.needs.me} href={props.needs.href?.(props.pull)} merging={st.busy} onMerge={merge} />
            {st.error ? <ErrorNote data-needs-error="">{`Could not merge: ${st.error}`}</ErrorNote> : null}
        </>
    );
});

/** How "Needs you" draws a pull request: Home's item (`MERGE`, "Squash and merge") or an Inbox notification row. */
export type PullRowSurface = 'home' | 'notification';

/** A PR as an Inbox row (#951): `PullCard`'s `notification` surface, the headline linked to the PR page. */
export const PullNoticeRow = component<{ pull: PullRequest; needs: PullNeeds }>(({ props }) => () => (
    <PullCard pull={props.pull} surface="notification" me={props.needs.me} href={props.needs.href?.(props.pull)} />
));

/** The section: heading with the open count, the rows, or the inbox empty state. */
export const NeedsYou = component<{ source: NeedsSource; pulls?: PullNeeds; pullSurface?: PullRowSurface }>(({ props }) => {
    const rows = props.source.useRows();
    const pulls = props.pulls?.usePulls();
    return () => {
        const sorted = sortRows(rows());
        const prs = pulls && props.pulls ? pullsNeedingYou(pulls(), props.pulls.me) : [];
        const needs = props.pulls;
        return (
            <section data-home-needs aria-label="Needs you">
                <SectionHeading count={`${sorted.length + prs.length} open`} slots={{ aside: () => 'answer here, in the chat, or on your phone' }}>Needs you</SectionHeading>
                {sorted.length || prs.length
                    ? (
                        <div data-needs-list>
                            {sorted.map((row) => <div key={row.id} data-needs-row><NeedsRowView row={row} source={props.source} /></div>)}
                            {needs ? prs.map((pr) => <div key={`pr:${pr.repo}#${pr.number}`} data-needs-row data-needs-pull={String(pr.number)}>{props.pullSurface === 'notification' ? <PullNoticeRow pull={pr} needs={needs} /> : <PullRowView pull={pr} needs={needs} />}</div>) : null}
                        </div>
                    )
                    : <EmptyState variant="inbox" />}
            </section>
        );
    };
});
