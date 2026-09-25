/**
 * The Pull board (#744, PRJ-08/09): header (title, branch, diff size, task and issue), the Opened → Checks → Review →
 * Approved → Merge stepper, what is happening now with Take over / Stop autopilot, Checks, Review threads; and the
 * 380px rail — Autopilot switches, Merge (every blocker in one sentence, `Squash and merge`, the approval note),
 * Linked items. One view for mock and live data: `Pull` feeds it; the switches and actions are local until the git
 * feature's autopilot writes exist (G3), and `readOnly` (live) disables them.
 */
import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import type { Autopilot, PullRequest } from '@agentic/core';
import { AgentTile, Button, ChecksBar, EnvironmentLine, Icon, Switch, type AgentHue } from '@agentic/ui';
import { formatTime } from '../../../../mock/workspace';
import {
    APPROVAL_NOTE, REVIEW_LABEL, THREAD_LABEL, autopilotOff, autopilotRows, blockerSentence, canMerge, diffText, durationText, openedAgo, originText, pullNow, pullSteps,
    type AutopilotSwitch, type PullLinked, type PullPageData
} from './model';

export interface PullAgent {
    readonly name: string;
    readonly hue?: AgentHue;
}

export type PullViewProps =
    & Define.Prop<'projectId', string, true>
    & Define.Prop<'data', PullPageData, true>
    & Define.Prop<'agentOf', (id: string) => PullAgent | undefined, true>
    & Define.Prop<'now', number, true>
    /** Live: the switches and actions are shown but disabled until autopilot writes exist. */
    & Define.Prop<'readOnly', boolean>;

const PROVIDER_LABEL: Readonly<Record<string, string>> = { github: 'GitHub' };
const LATER = 'Arrives with the git feature’s autopilot controls';

export const PullView = component<PullViewProps>(({ props }) => {
    // Local until the autopilot writes exist: Take over / Stop and the switches edit this copy.
    // Local until the autopilot writes exist: Take over / Stop and the switches edit a copy taken at setup (`Pull` keys
    // the view by PR number, so another PR gets a fresh copy); read-only (live) renders the PR's own autopilot.
    const initial = props.data.pr.autopilot;
    const st = signal({ autopilot: (initial ? { ...initial } : null) as Autopilot | null, stopped: '' as '' | 'you' | 'stopped', asked: false });
    const autopilot = (): Autopilot | undefined => (props.readOnly ? props.data.pr.autopilot : (st.autopilot ?? undefined));
    const setSwitch = (key: AutopilotSwitch, on: boolean): void => {
        if (!props.readOnly && st.autopilot && st.autopilot[key] !== on) st.autopilot = { ...st.autopilot, [key]: on };
    };
    const stop = (by: 'you' | 'stopped'): void => {
        if (!st.autopilot) return;
        st.autopilot = autopilotOff(st.autopilot);
        st.stopped = by;
    };

    const person = (id: string): PullAgent => (id === 'you' ? { name: 'You' } : (props.agentOf(id) ?? { name: id }));
    const tile = (id: string, size: 18 | 20 = 20) => {
        const who = person(id);
        return <AgentTile name={who.name} hue={who.hue} size={size} person={id === 'you' || !props.agentOf(id)} />;
    };

    const Header = (pr: PullRequest, linked: PullLinked | undefined) => (
        <header data-pull-head="">
            <div data-pull-title-row="">
                <Icon name="branch" size={18} />
                <h2 data-pull-title="">{pr.title}</h2>
                <span data-pull-ref="">{`${pr.repo.split('/').pop()}#${pr.number}`}</span>
                <Button href={pr.url} icon="link" label={`Open on ${PROVIDER_LABEL[pr.provider] ?? pr.provider}`} />
            </div>
            <p data-pull-meta="">
                {tile(pr.openedBy, 18)}
                <span>{`${person(pr.openedBy).name} opened ${openedAgo(pr.openedAt, props.now)}`}</span>
                <span data-mono="">{`${pr.head} → ${pr.base}`}</span>
                <span data-mono="" data-pull-diff="">{diffText(pr)}</span>
                {originText(pr, linked) ? <span data-pull-origin="">{originText(pr, linked)}</span> : null}
            </p>
        </header>
    );

    const Steps = (pr: PullRequest) => (
        <ol data-pull-steps="" aria-label="Pull request progress">
            {pullSteps(pr, formatTime).map((s) => (
                <li key={s.name} data-step={s.state} data-tone={s.tone} aria-current={s.state === 'current' ? 'step' : undefined}>
                    <span data-step-dot="" aria-hidden="true">{s.state === 'passed' ? <Icon name="check" size={12} /> : null}</span>
                    <strong>{s.name}</strong>
                    {s.detail ? <small>{s.detail}</small> : null}
                </li>
            ))}
        </ol>
    );

    const Now = (pr: PullRequest) => {
        if (st.stopped) {
            return (
                <section data-pull-now="" data-stopped={st.stopped} aria-label="What is happening now">
                    <p>{st.stopped === 'you' ? 'You took over. Autopilot is off; the next move is yours.' : 'Autopilot stopped. Nothing runs on this PR until you turn it back on.'}</p>
                </section>
            );
        }
        const now = pullNow(pr, (id) => person(id).name);
        if (!now) return null;
        return (
            <section data-pull-now="" aria-label="What is happening now">
                <div data-pull-now-head="">
                    <strong>{now.title}</strong>
                    <span data-tag="autopilot">autopilot</span>
                    {now.attempt ? <span data-pull-attempt="">{now.attempt}</span> : null}
                </div>
                {now.body ? <p data-pull-now-body="">{now.body}</p> : null}
                {props.readOnly ? <p data-pull-later="">{LATER}</p> : null}
                <div data-pull-now-actions="">
                    {pr.sessionId ? <Link to={`/sessions/${pr.sessionId}`}>{`Watch session ${pr.sessionId}`}</Link> : null}
                    {pr.chatId ? <Link to={`/chats/${pr.chatId}`}>Open chat</Link> : null}
                    <span data-spacer="" />
                    <Button label="Take over" name="take-over" disabled={props.readOnly} onClick={() => stop('you')} />
                    <Button label="Stop autopilot" icon="stop" name="stop-autopilot" disabled={props.readOnly} onClick={() => stop('stopped')} />
                </div>
            </section>
        );
    };

    const Checks = (pr: PullRequest) => (
        <section data-pull-checks="" aria-label="Checks">
            <div data-pull-section-head="">
                <h3>{`Checks · ${pr.checks.length}`}</h3>
                {pr.checks.length ? <ChecksBar checks={pr.checks} /> : null}
            </div>
            {pr.checks.length
                ? (
                    <ul>
                        {pr.checks.map((c) => (
                            <li key={c.name} data-check={c.state}>
                                <span data-check-mark="" aria-hidden="true">{c.state === 'passed' ? <Icon name="check" size={13} /> : c.state === 'failed' ? <Icon name="close" size={13} /> : null}</span>
                                <span data-check-name="">{c.name}</span>
                                <span data-check-detail="">{c.state === 'passed' ? '' : c.detail ?? c.state}</span>
                                <span data-check-time="">{durationText(c.durationMs)}</span>
                            </li>
                        ))}
                    </ul>
                )
                : <p data-none="">No checks reported yet.</p>}
        </section>
    );

    const Review = (pr: PullRequest) => {
        const open = pr.review.threads.filter((t) => t.state !== 'resolved').length;
        return (
            <section data-pull-review="" aria-label="Review threads">
                <div data-pull-section-head="">
                    <h3>{`Review · ${open} open ${open === 1 ? 'thread' : 'threads'}`}</h3>
                    <span data-review-state={pr.review.state}>{REVIEW_LABEL[pr.review.state]}</span>
                </div>
                {pr.review.threads.length
                    ? (
                        <ul>
                            {pr.review.threads.map((t) => (
                                <li key={t.id} data-thread={t.state}>
                                    <div data-thread-head="">
                                        {tile(t.author, 18)}
                                        <strong>{person(t.author).name}</strong>
                                        {t.path ? <span data-mono="">{t.line !== undefined ? `${t.path}:${t.line}` : t.path}</span> : null}
                                        <span data-thread-state={t.state}>
                                            {t.state === 'replying' && pr.autopilot ? `${person(pr.autopilot.agentId).name} replying` : THREAD_LABEL[t.state]}
                                        </span>
                                    </div>
                                    <p>{t.body}</p>
                                    {t.reply ? <p data-thread-reply="">{`${pr.autopilot ? person(pr.autopilot.agentId).name : 'Reply'}: ${t.reply}`}</p> : null}
                                </li>
                            ))}
                        </ul>
                    )
                    : <p data-none="">No review threads.</p>}
            </section>
        );
    };

    const Autopilot = (pr: PullRequest) => {
        const a = autopilot();
        return (
            <section data-pull-autopilot="" aria-label="Autopilot">
                <div data-pull-section-head="">
                    <h3>Autopilot</h3>
                    {a ? <span>{person(a.agentId).name}</span> : null}
                </div>
                {a
                    ? (
                        <ul>
                            {autopilotRows(a, pr.base).map((row) => (
                                <li key={row.key} data-switch={row.key}>
                                    <div>
                                        <strong>{row.label}</strong>
                                        <small>{row.caption}</small>
                                    </div>
                                    <Switch label={row.label} hideLabel model={() => a[row.key]} disabled={props.readOnly || pr.state !== 'open'} onCheckedChange={(on: boolean) => setSwitch(row.key, on)} />
                                </li>
                            ))}
                        </ul>
                    )
                    : <p data-none="">No agent is on this PR.</p>}
            </section>
        );
    };

    const Merge = (pr: PullRequest) => {
        const ready = canMerge(pr);
        return (
            <section data-pull-merge="" aria-label="Merge">
                <h3>Merge</h3>
                <p data-pull-blockers="">{blockerSentence(pr)}</p>
                {pr.state === 'open'
                    ? (
                        <>
                            <Button label="Squash and merge" name="merge" icon="commit" block disabled={!ready || props.readOnly || st.asked} onClick={() => { st.asked = true; }} />
                            <p data-pull-approval="">{st.asked ? 'Asked for approval: rule ask on merge' : APPROVAL_NOTE}</p>
                        </>
                    )
                    : null}
            </section>
        );
    };

    const Linked = (pr: PullRequest, linked: PullLinked | undefined) => {
        const env = linked?.environment;
        return (
            <section data-pull-linked="" aria-label="Linked">
                <h3>Linked</h3>
                <dl>
                    <dt>Task</dt>
                    <dd data-link="task">{pr.taskId ? <><Link to={`/tasks/${pr.taskId}`}>{pr.taskId}</Link>{linked?.taskTitle ? <span data-task-title="">{linked.taskTitle}</span> : null}</> : <span data-none="">No task</span>}</dd>
                    {linked?.issue ? <><dt>Issue</dt><dd data-link="issue">{linked.issue.label}</dd></> : null}
                    <dt>Chat</dt>
                    <dd data-link="chat">{pr.chatId ? <Link to={`/chats/${pr.chatId}`}>{linked?.chatTitle ?? pr.chatId}</Link> : <span data-none="">No chat</span>}</dd>
                    <dt>Session</dt>
                    <dd data-link="session">{pr.sessionId ? <Link to={`/sessions/${pr.sessionId}`}>{pr.sessionId}</Link> : <span data-none="">No session</span>}</dd>
                    {env ? <><dt>Runs on</dt><dd data-link="environment"><EnvironmentLine machine={env.machine} runtime={env.runtime} account={env.account} tone="live" /></dd></> : null}
                    {pr.after !== undefined
                        ? <><dt>Stack</dt><dd data-link="stack"><Link to={`/projects/${props.projectId}/work/pr:${pr.after}`}>{`after #${pr.after}`}</Link><span>· rebases when it merges</span></dd></>
                        : null}
                </dl>
            </section>
        );
    };

    return () => {
        const { pr, linked } = props.data;
        return (
            <div data-pull-board="" data-pull-state={pr.state}>
                <div data-pull-main="">
                    {Header(pr, linked)}
                    {Steps(pr)}
                    {Now(pr)}
                    {Checks(pr)}
                    {Review(pr)}
                </div>
                <aside data-pull-rail="" aria-label="Pull request actions">
                    {Autopilot(pr)}
                    {Merge(pr)}
                    {Linked(pr, linked)}
                </aside>
            </div>
        );
    };
}, { name: 'PullView' });
