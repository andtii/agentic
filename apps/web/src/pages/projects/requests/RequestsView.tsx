/**
 * The Requests inbox (#761; HANDOFF.md → "Project manager and requests", board `Requests`): tabs Incoming / Sent /
 * Linked; a 360px list of requests with their state pill, origin project and sender; and the detail — origin path
 * (project › chat › sender), what they sent (quote and refs), the manager's triage card (kind, priority, reproduced,
 * similar, the proposed item, the optional GitHub issue, the `why you:` line), the reply the manager will post back,
 * and the actions Accept as proposed, Edit first, Ask for more, Decline. Edit first opens the proposed item in an
 * editable form; Ask for more and Decline ask for the question or the reason first.
 *
 * The view keeps only what is on screen (tab, selection, open form); the page owns the entries and resolves them.
 */
import { component, signal, type Define } from 'sigx';
import { derivedModel } from '@sigx/zero/behaviors';
import type { ProjectRecord, Ref, TriageProposedItem } from '@agentic/core';
import { AgentTile, Button, Icon, Segmented, SelectField, StatusPill, Switch, SwitchField, TextField, TextareaField } from '@agentic/ui';
import { Age } from '../../../components/Age';
import { refIcon, refLabel } from '../features/plan/shared/model';
import {
    BOX_LABELS, PRIORITY_LABELS, REQUEST_BOXES, actorName, boxCount, draftErrors, draftOf, entriesIn, githubRepoOf, itemMeta, itemOfDraft,
    kindLine, phaseName, requestPill, senderLine, type ActorNames, type ItemDraft, type RequestBox, type RequestEntry
} from './model';

/** How a request is accepted when it is not exactly as proposed. */
export interface AcceptEdit {
    readonly item: TriageProposedItem;
    readonly openIssue: boolean;
}

export type RequestsViewProps =
    & Define.Prop<'project', ProjectRecord, true>
    & Define.Prop<'entries', readonly RequestEntry[], true>
    /** The project manager's name (`Atlas`). */
    & Define.Prop<'manager', string, true>
    & Define.Prop<'names', ActorNames, true>
    /** The person reading, by name. */
    & Define.Prop<'you', string, true>
    /** The plan's phases, for the proposed item and the Edit-first form. */
    & Define.Prop<'phases', readonly { n: number; title: string }[], true>
    /** The clock ages are measured against. */
    & Define.Prop<'now', number>
    /** Shown above the list (a live read that failed, a store that is not there yet). */
    & Define.Prop<'note', string>
    & Define.Prop<'onAccept', (id: string, edit?: AcceptEdit) => void, true>
    & Define.Prop<'onAskForMore', (id: string, question: string) => void, true>
    & Define.Prop<'onDecline', (id: string, reason: string) => void, true>;

type Mode = 'view' | 'edit' | 'ask' | 'decline';

const RefChip = (ref: Ref) => (
    <span data-requests-ref={ref.kind}><Icon name={refIcon(ref)} size={12} />{refLabel(ref)}</span>
);

export const RequestsView = component<RequestsViewProps>(({ props }) => {
    const st = signal({
        box: 'incoming' as RequestBox,
        selected: '' as string,
        mode: 'view' as Mode,
        draft: null as ItemDraft | null,
        text: '',
        openIssue: null as boolean | null,
        tried: false
    });
    const reset = (): void => {
        st.mode = 'view';
        st.draft = null;
        st.text = '';
        st.openIssue = null;
        st.tried = false;
    };
    const select = (id: string): void => {
        if (st.selected === id) return;
        st.selected = id;
        reset();
    };
    const setBox = (box: RequestBox): void => {
        st.box = box;
        st.selected = '';
        reset();
    };

    /** The entries of the open tab, and the one the detail shows: the selected one, else the first. */
    const rowsOf = (): RequestEntry[] => entriesIn(props.entries, st.box);
    const currentOf = (rows: readonly RequestEntry[]): RequestEntry | undefined => rows.find((e) => e.request.id === st.selected) ?? rows[0];
    /** The "open GitHub issue" switch: the triage's choice until the person flips it. */
    const issueModel = derivedModel<boolean>(
        () => st.openIssue ?? currentOf(rowsOf())?.request.triage?.openIssue ?? false,
        (next) => { st.openIssue = next; }
    );

    const age = (at: number) => <Age at={at} now={props.now} />;

    const origin = (e: RequestEntry) => (
        <span data-requests-origin="">
            <span data-requests-chip="project"><Icon name="folder" size={12} />{e.fromProjectName}</span>
            {e.request.sender.kind === 'agent'
                ? <AgentTile name={props.names(e.request.sender.agentId).name} hue={props.names(e.request.sender.agentId).hue} size={20} />
                : <AgentTile name={actorName(e.request.sender, props.names, props.you)} person size={20} />}
        </span>
    );

    const listLine = (e: RequestEntry) => {
        const r = e.request;
        if (r.state === 'accepted' && r.resultItem !== undefined) return <span data-requests-row-note="result">{`→ ${e.toProjectName}#${r.resultItem}`}</span>;
        return e.note ? <span data-requests-row-note="">{`· ${e.note}`}</span> : null;
    };

    const row = (e: RequestEntry, selected: boolean) => {
        const r = e.request;
        const pill = requestPill(r.state, props.manager);
        return (
            <li data-requests-row={r.id} data-state={r.state} data-selected={selected ? '' : undefined}>
                <button type="button" aria-current={selected ? 'true' : undefined} onClick={() => select(r.id)}>
                    <span data-requests-row-head="">
                        <StatusPill status={r.state} label={pill.label} tone={pill.tone} hollow={pill.hollow} />
                        <span data-requests-row-age="" data-fresh={r.state === 'needs-you' ? '' : undefined}>{age(r.createdAt)}</span>
                    </span>
                    <span data-requests-row-title="">{r.title}</span>
                    <span data-requests-row-meta="">{origin(e)}{listLine(e)}</span>
                </button>
            </li>
        );
    };

    const kv = (k: string, v: unknown, key: string) => (
        <div data-requests-kv={key}>
            <dt>{k}</dt>
            <dd>{v}</dd>
        </div>
    );

    const triageCard = (e: RequestEntry) => {
        const r = e.request;
        const t = r.triage;
        if (!t) {
            return (
                <section data-requests-triage="pending" aria-label={`${props.manager}’s triage`}>
                    <p data-requests-empty="">{`${props.manager} is triaging this request; it comes to you if it changes the plan.`}</p>
                </section>
            );
        }
        const item = t.proposedItem;
        const repo = githubRepoOf(props.project);
        const editable = r.state === 'needs-you';
        const openIssue = st.openIssue ?? t.openIssue;
        return (
            <section data-requests-triage="" aria-label={`${props.manager}’s triage`}>
                <header data-requests-triage-head="">
                    <AgentTile name={props.manager} size={22} />
                    <span data-requests-triage-title="">{`${props.manager}’s triage`}</span>
                    {e.triagedAt !== undefined ? <span data-requests-triage-age="">{age(e.triagedAt)}</span> : null}
                    {t.why ? <span data-requests-why="">{`why you: ${t.why}`}</span> : null}
                </header>
                <dl data-requests-kvs="">
                    {kv('Kind', kindLine(t, e.area), 'kind')}
                    {kv('Priority', <><b>{PRIORITY_LABELS[t.priority]}</b>{t.priorityNote ? <span data-requests-dim="">{` ${t.priorityNote}`}</span> : null}</>, 'priority')}
                    {t.reproduced
                        ? kv('Reproduced', <><Icon name={t.reproduced.ok ? 'check' : 'close'} size={12} /><span>{t.reproduced.note ?? (t.reproduced.ok ? 'yes' : 'not yet')}</span></>, 'reproduced')
                        : null}
                    {t.similar.length
                        ? kv('Similar', t.similar.map((s) => <span data-requests-similar="">{RefChip(s.ref)}{s.note ? <span data-requests-dim="">{s.note}</span> : null}</span>), 'similar')
                        : null}
                    {item
                        ? kv('New item', (
                            <span data-requests-item="">
                                <b data-requests-item-title="">{item.title}</b>
                                <span data-requests-item-meta="">
                                    <span data-requests-mono="">{phaseName(item.phase, props.phases)}</span>
                                    {' · '}
                                    {item.assignee?.kind === 'agent' ? <AgentTile name={props.names(item.assignee.agentId).name} hue={props.names(item.assignee.agentId).hue} size={18} /> : null}
                                    {itemMeta(item, props.names, props.you)}
                                </span>
                            </span>
                        ), 'item')
                        : null}
                    {repo
                        ? kv('Also', (
                            <span data-requests-also="">
                                <Icon name="branch" size={12} />
                                <span>{`open GitHub issue in ${repo}`}</span>
                                {editable
                                    ? <Switch model={issueModel} label={`Open GitHub issue in ${repo}`} hideLabel />
                                    : <span data-requests-dim="">{openIssue ? 'yes' : 'no'}</span>}
                            </span>
                        ), 'also')
                        : null}
                </dl>
            </section>
        );
    };

    const editForm = (e: RequestEntry) => {
        const d = st.draft!;
        const errors = st.tried ? draftErrors(d) : {};
        const members = props.project.members.agentIds.map((id) => ({ value: id as string, label: props.names(id).name }));
        const save = (): void => {
            st.tried = true;
            if (Object.keys(draftErrors(st.draft!)).length) return;
            props.onAccept(e.request.id, { item: itemOfDraft(st.draft!, e.request.triage?.proposedItem), openIssue: st.draft!.openIssue });
            reset();
        };
        return (
            <form data-requests-edit="" aria-label="Edit the proposed item" onSubmit={(ev: Event) => { ev.preventDefault(); save(); }}>
                <TextField model={[d, 'title']} name="item-title" label="Title" required error={errors.title} />
                <div data-requests-edit-row="">
                    <SelectField model={[d, 'phase']} name="item-phase" label="Phase"
                        options={[{ value: '', label: 'First open phase' }, ...props.phases.map((p) => ({ value: String(p.n), label: p.title }))]} />
                    <SelectField model={[d, 'assignee']} name="item-assignee" label="Assignee"
                        options={[{ value: '', label: 'Unassigned' }, ...members]} />
                </div>
                <TextareaField model={[d, 'doneWhen']} name="item-done-when" label="Done when" description="One condition per line." rows={3} />
                <SwitchField model={[d, 'first']} name="item-first" label="Top of the assignee’s queue" />
                {githubRepoOf(props.project)
                    ? <SwitchField model={[d, 'openIssue']} name="item-open-issue" label={`Open GitHub issue in ${githubRepoOf(props.project)}`} />
                    : null}
                <div data-requests-actions="">
                    <Button intent="wait" icon="check" type="submit">Accept with changes</Button>
                    <Button onClick={reset}>Cancel</Button>
                </div>
            </form>
        );
    };

    const textForm = (e: RequestEntry, kind: 'ask' | 'decline') => {
        const label = kind === 'ask' ? `What should ${props.manager} ask?` : 'Why decline?';
        const submit = (): void => {
            st.tried = true;
            if (!st.text.trim()) return;
            if (kind === 'ask') props.onAskForMore(e.request.id, st.text);
            else props.onDecline(e.request.id, st.text);
            reset();
        };
        return (
            <form data-requests-text-form={kind} aria-label={label} onSubmit={(ev: Event) => { ev.preventDefault(); submit(); }}>
                <TextareaField model={() => st.text} name={kind === 'ask' ? 'ask-question' : 'decline-reason'} label={label} rows={3} required
                    description={`${props.manager} posts it in ${e.fromProjectName}.`} error={st.tried && !st.text.trim() ? (kind === 'ask' ? 'Say what is missing.' : 'Give a reason.') : undefined} />
                <div data-requests-actions="">
                    {kind === 'ask'
                        ? <Button icon="chats" type="submit">Send question</Button>
                        : <Button intent="danger" icon="close" type="submit">Decline</Button>}
                    <Button onClick={reset}>Cancel</Button>
                </div>
            </form>
        );
    };

    const actions = (e: RequestEntry) => {
        const t = e.request.triage;
        const accept = (): void => {
            const changed = t && st.openIssue !== null && st.openIssue !== t.openIssue;
            props.onAccept(e.request.id, changed && t.proposedItem ? { item: t.proposedItem, openIssue: st.openIssue! } : undefined);
            reset();
        };
        return (
            <div data-requests-actions="">
                <Button intent="wait" icon="check" onClick={accept}>Accept as proposed</Button>
                {t?.proposedItem ? <Button icon="edit" onClick={() => { st.draft = draftOf(t); st.mode = 'edit'; }}>Edit first</Button> : null}
                <Button icon="chats" onClick={() => { st.mode = 'ask'; }}>Ask for more</Button>
                <span data-requests-actions-end="">
                    <Button intent="danger" icon="close" onClick={() => { st.mode = 'decline'; }}>Decline</Button>
                </span>
            </div>
        );
    };

    const outcome = (e: RequestEntry) => {
        const r = e.request;
        if (r.state === 'accepted') return <p data-requests-outcome="accepted">{`Accepted as ${e.toProjectName}#${r.resultItem ?? '?'}.`}</p>;
        if (r.state === 'declined') return <p data-requests-outcome="declined">{`Declined: ${r.declineReason ?? ''}`}</p>;
        if (r.state === 'asked-for-more') return <p data-requests-outcome="asked">{e.note ?? `${props.manager} asked ${e.fromProjectName} for more.`}</p>;
        return null;
    };

    const detail = (e: RequestEntry) => {
        const r = e.request;
        const pill = requestPill(r.state, props.manager);
        const t = r.triage;
        return (
            <article data-requests-detail={r.id} aria-label={r.title}>
                <header data-requests-detail-head="">
                    <StatusPill status={r.state} label={pill.label} tone={pill.tone} hollow={pill.hollow} />
                    <span data-requests-id="">{r.id}</span>
                </header>
                <h2 data-requests-title="">{r.title}</h2>
                <nav data-requests-path="" aria-label="Origin">
                    <span data-requests-chip="project"><Icon name="folder" size={12} />{e.fromProjectName}</span>
                    {e.fromChatTitle ? <><Icon name="chevron-right" size={12} /><span data-requests-chip="chat"><Icon name="chats" size={12} />{e.fromChatTitle}</span></> : null}
                    <Icon name="chevron-right" size={12} />
                    <span data-requests-sender="">
                        {r.sender.kind === 'agent' ? <AgentTile name={props.names(r.sender.agentId).name} hue={props.names(r.sender.agentId).hue} size={20} /> : <AgentTile name={props.you} person size={20} />}
                        {senderLine(e, props.names, props.you)}
                    </span>
                    <span data-requests-detail-age="">{age(r.createdAt)}</span>
                </nav>

                <h3 data-requests-label="">What they sent</h3>
                <blockquote data-requests-sent="">
                    <p>{r.body}</p>
                    {r.refs.length ? <span data-requests-refs="">{r.refs.map(RefChip)}</span> : null}
                </blockquote>

                {e.box !== 'linked' ? triageCard(e) : null}

                {t && r.state === 'needs-you' && st.mode === 'view'
                    ? (
                        <section data-requests-reply="" aria-label="Reply">
                            <span data-requests-reply-head=""><Icon name="send" size={12} />{`Reply ${props.manager} will post in ${e.fromProjectName}`}</span>
                            <p>{t.reply}</p>
                        </section>
                    )
                    : null}

                {r.state === 'needs-you'
                    ? st.mode === 'edit' && st.draft ? editForm(e) : st.mode === 'ask' ? textForm(e, 'ask') : st.mode === 'decline' ? textForm(e, 'decline') : actions(e)
                    : outcome(e)}
            </article>
        );
    };

    const EMPTY: Readonly<Record<RequestBox, string>> = {
        incoming: 'No requests from other projects yet.',
        sent: 'Nothing sent from here yet. Agents send one with projects_request.',
        linked: 'No items linked across projects yet.'
    };

    return () => {
        const p = props.project;
        const rows = rowsOf();
        const current = currentOf(rows);
        return (
            <div data-requests={p.id}>
                <header data-requests-head="">
                    <p data-requests-lede="">{`What other projects ask ${p.name} for. ${props.manager}, the project manager, triages each one and asks you when it changes the plan.`}</p>
                    <Segmented
                        model={() => st.box}
                        onValueChange={(v: string) => setBox(v as RequestBox)}
                        label="Requests"
                        options={REQUEST_BOXES.map((b) => ({ value: b, label: `${BOX_LABELS[b]} ${boxCount(props.entries, b)}` }))}
                    />
                </header>
                {props.note ? <p data-requests-note="">{props.note}</p> : null}
                <div data-requests-body="">
                    <section data-requests-list="" aria-label={BOX_LABELS[st.box]}>
                        <header data-requests-list-head="">
                            <span>{BOX_LABELS[st.box]}</span>
                            <span data-requests-dim="">newest first</span>
                        </header>
                        {rows.length
                            ? <ul>{rows.map((e) => row(e, e === current))}</ul>
                            : <p data-requests-empty="">{EMPTY[st.box]}</p>}
                    </section>
                    {current ? detail(current) : null}
                </div>
            </div>
        );
    };
}, { name: 'RequestsView' });
