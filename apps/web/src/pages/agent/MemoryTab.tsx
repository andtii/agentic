import { component, effect, onUnmounted, signal, type Define } from 'sigx';
import { Card } from '@sigx/zero-daisyui/components';
import type { MemoryEntry, MemoryKind } from '@agentic/core';
import { Button, ConfirmDialog, EmptyState, ErrorNote, FilterChips, FormDialog, Icon, Label, StatusPill, Switch, Tag, TextareaField } from '@agentic/ui';
import { Col } from '@sigx/zero';
import { MEMORY_KINDS, memoryCounts, type AgentProfile } from '../../mock/agents';
import { agentClock, shortDate, dateTime } from './format';

/**
 * Where the tab's actions go on the platform (#153): the Memory actor of the
 * agent's private scope and, for the learning switch, the Agent's config. The
 * tab then lists `profile.memories` as the page re-reads them — the actor is
 * the truth. `remove` is optional: the Delete control is drawn only where a
 * delete exists (the AC-15 rule — an unsupported control is never drawn).
 */
export interface MemoryTabStore {
    correct(entry: MemoryEntry, text: string): Promise<unknown>;
    retire(entry: MemoryEntry): Promise<unknown>;
    remove?(entry: MemoryEntry): Promise<unknown>;
    setLearning(on: boolean): Promise<unknown>;
}

export type MemoryTabProps =
    & Define.Prop<'profile', AgentProfile, true>
    /** Live mode: act through the actors; absent, the actions mutate a local copy (the mock page). */
    & Define.Prop<'store', MemoryTabStore>
    /** The workspace's IANA zone; absent, the mock workspace's. */
    & Define.Prop<'zone', string>
    /** The memory plugin the entries come from — the workspace's active one (#281); absent, the tab does not say. */
    & Define.Prop<'source', string>;

type Filter = MemoryKind | 'all';

const KIND_LABELS: Record<Filter, string> = {
    all: 'All',
    lesson: 'Lessons',
    preference: 'Preferences',
    fact: 'Facts',
    record: 'Records',
    assumption: 'Assumptions',
    working: 'Working'
};

/** The confidence pill: VERIFIED solid live, STATED hollow muted, ASSUMED hollow amber (MEM-06). */
export function confidencePill(confidence: MemoryEntry['confidence']): { status: string; label: string; tone: 'live' | 'muted' | 'needs-you'; hollow: boolean } {
    switch (confidence) {
        case 'verified':
            return { status: 'verified', label: 'VERIFIED', tone: 'live', hollow: false };
        case 'assumed':
            return { status: 'assumed', label: 'ASSUMED', tone: 'needs-you', hollow: true };
        default:
            return { status: 'stated', label: 'STATED', tone: 'muted', hollow: true };
    }
}

/** `your correction · chat Mobile pass #47 · 17 Sep 14:20` — where the memory came from (MEM-08). */
export function provenanceLine(entry: MemoryEntry, zone?: string): string {
    const p = entry.provenance;
    const who =
        p.source === 'user' ? (entry.kind === 'lesson' ? 'your correction' : 'your message')
        : p.source === 'verification' ? 'verified'
        : p.source === 'import' ? 'imported'
        : 'the agent';
    const refs: string[] = [];
    if (p.taskId) refs.push(`task ${p.taskId}`);
    if (p.sessionId) refs.push(`session ${p.sessionId}`);
    if (entry.subject) refs.push(entry.subject);
    // The page's clock: the mock workspace's frozen one in mock mode, so its rows never drift from a time to a date.
    const when = agentClock() - p.at < 86_400_000 ? dateTime(p.at, zone) : shortDate(p.at, zone);
    return [who, ...refs, when].join(' · ');
}

/**
 * Memory: filter chips by kind with counts, the row grid
 * `110px 1fr 100px 120px` (kind tag, text + conditions + provenance,
 * confidence pill, actions), retired rows at 55 % with strikethrough and
 * the superseding reason; the rail lists scopes, what the runtime gets and
 * the learning counters (`docs/design/HANDOFF.md` → Agent memory).
 * Correct / retire / delete go through `store` on the platform (#153) and
 * mutate a local copy on the mock page.
 */
export const MemoryTab = component<MemoryTabProps>(({ props }) => {
    const state = signal({
        filter: 'all' as string,
        entries: props.profile.memories.map((e) => ({ ...e })) as MemoryEntry[],
        learning: props.profile.learning,
        correcting: null as MemoryEntry | null,
        correction: '',
        deleting: null as MemoryEntry | null,
        correctOpen: false,
        deleteOpen: false,
        error: ''
    });

    // With a store the list is the page's read of the actor; without one, the local copy.
    const entries = (): readonly MemoryEntry[] => (props.store ? props.profile.memories : state.entries);
    const run = (action: Promise<unknown>): void => {
        state.error = '';
        void action.catch((e: unknown) => { state.error = e instanceof Error ? e.message : String(e); });
    };
    // The switch is bound to `state.learning`. On the platform a flip is a config version, and a
    // change from elsewhere (another tab, a rollback) moves the switch — it is never written back.
    let synced = props.profile.learning;
    const stopLearning = effect(() => {
        const remote = props.profile.learning;
        const on = state.learning;
        const store = props.store;
        if (!store) return;
        if (remote !== synced) {
            synced = remote;
            state.learning = remote;
        } else if (on !== synced) {
            synced = on;
            state.error = '';
            void store.setLearning(on).catch((e: unknown) => {
                synced = props.profile.learning;
                state.learning = synced;
                state.error = e instanceof Error ? e.message : String(e);
            });
        }
    });
    onUnmounted(stopLearning);

    const visible = () => (state.filter === 'all' ? entries() : entries().filter((e) => e.kind === state.filter));
    const update = (id: string, patch: Partial<MemoryEntry>) => {
        state.entries = state.entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    };
    const openCorrect = (entry: MemoryEntry) => {
        state.correcting = entry;
        state.correction = entry.text;
        state.correctOpen = true;
    };
    const confirmCorrect = () => {
        const entry = state.correcting;
        const text = entry ? state.correction.trim() || entry.text : '';
        if (entry && props.store) run(props.store.correct(entry, text));
        else if (entry) update(entry.id, { text, confidence: 'stated', provenance: { source: 'user', at: Date.now() } });
        state.correctOpen = false;
        state.correcting = null;
    };
    const retire = (entry: MemoryEntry) => {
        if (props.store) run(props.store.retire(entry));
        else update(entry.id, { retired: true, supersedes: `retired by you · ${dateTime(Date.now())}` });
    };
    const openDelete = (entry: MemoryEntry) => {
        state.deleting = entry;
        state.deleteOpen = true;
    };
    const confirmDelete = () => {
        const entry = state.deleting;
        if (entry && props.store) {
            if (props.store.remove) run(props.store.remove(entry));
        } else if (entry) state.entries = state.entries.filter((e) => e.id !== entry.id);
        state.deleteOpen = false;
        state.deleting = null;
    };
    const exportHref = () => `data:application/x-ndjson;charset=utf-8,${encodeURIComponent(entries().map((e) => JSON.stringify(e)).join('\n'))}`;

    return () => {
        const p = props.profile;
        const canDelete = !props.store || !!props.store.remove;
        const counts = memoryCounts(entries());
        const chips: Filter[] = ['all', ...MEMORY_KINDS.filter((k) => counts[k] > 0)];
        const rows = visible();
        return (
            <div data-agent-memory="">
                <Col gap="lg">
                    <div data-memory-toolbar="">
                        <div data-memory-filters="">
                            <FilterChips
                                model={() => state.filter}
                                label="Filter by kind"
                                options={chips.map((kind) => ({ value: kind, label: KIND_LABELS[kind], count: counts[kind] }))}
                            />
                        </div>
                        <a data-memory-export="" href={exportHref()} download={`${p.config.name.toLowerCase()}-memory.ndjson`}>
                            <Icon name="download" size={15} />
                            <span>Export NDJSON</span>
                        </a>
                    </div>
                    {props.source ? <p data-memory-source="">Stored by {props.source}, the workspace's active memory.</p> : null}
                    {state.error ? <ErrorNote data-memory-error="">{state.error}</ErrorNote> : null}
                    {rows.length ? (
                        <ul data-memory-list="" aria-label="Memories">
                            {rows.map((e) => {
                                const pill = confidencePill(e.confidence);
                                return (
                                    <li data-memory-row="" data-memory-id={e.id} data-kind={e.kind} data-retired={e.retired ? '' : undefined}>
                                        <span data-memory-kind=""><Tag>{e.kind}</Tag></span>
                                        <div data-memory-body="">
                                            <p data-memory-text="">{e.text}</p>
                                            {e.retired ? (
                                                <p data-memory-superseded="">{e.supersedes ? `superseded by ${e.supersedes}` : 'retired'}</p>
                                            ) : (
                                                <>
                                                    {e.conditions ? (
                                                        <p data-memory-conditions="">
                                                            <span>applies when</span>
                                                            {e.conditions.split('·').map((c) => <Tag>{c.trim()}</Tag>)}
                                                        </p>
                                                    ) : null}
                                                    <p data-memory-provenance="">{provenanceLine(e, props.zone)}</p>
                                                </>
                                            )}
                                        </div>
                                        <span data-memory-confidence=""><StatusPill status={pill.status} label={pill.label} tone={pill.tone} hollow={pill.hollow} /></span>
                                        <span data-memory-actions="">
                                            <Button intent="icon" icon="edit" label="Correct this memory" disabled={!!e.retired} onClick={() => openCorrect(e)} />
                                            <Button intent="icon" icon="retire" label="Retire this memory" disabled={!!e.retired} onClick={() => retire(e)} />
                                            {canDelete ? <Button intent="icon" icon="trash" label="Delete this memory" onClick={() => openDelete(e)} /> : null}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <EmptyState variant="generic" title="No memories yet" caption="What this agent learns from sessions and your corrections shows up here." />
                    )}
                </Col>
                <aside data-memory-rail="" aria-label="Memory settings">
                <Col gap="lg">
                    <Card>
                        <Card.Body>
                            <Col gap="sm">
                                <Label>Scopes this agent can read</Label>
                                <ul data-memory-scopes="">
                                    {p.scopes.map((s) => (
                                        <li>
                                            <Icon name={s.shared ? 'link' : 'shield'} size={14} />
                                            <span class="mono">{s.scope}</span>
                                            <Tag>{s.shared ? 'shared' : 'private'}</Tag>
                                        </li>
                                    ))}
                                </ul>
                                <p data-tone="muted">Joining a chat never exposes the private scope to other agents.</p>
                            </Col>
                        </Card.Body>
                    </Card>
                    <Card>
                        <Card.Body>
                            <Col gap="sm">
                                <Label>Supplied to the runtime</Label>
                                <p data-tone="muted">Up to 20 entries or 4 KB are retrieved per task and placed in the system prompt. Claude Code's own memory files are runtime-owned and not shown here.</p>
                            </Col>
                        </Card.Body>
                    </Card>
                    <Card>
                        <Card.Body>
                            <Col gap="sm">
                                <div data-learning-head="">
                                    <Label>Learning</Label>
                                    <Switch model={() => state.learning} label="Learn from sessions" hideLabel />
                                </div>
                                <p data-tone="muted">Memory writes are automatic. Instruction changes wait for your review.</p>
                                <dl data-learning-counters="">
                                    <div><dt>Corrections this week</dt><dd>{p.correctionsThisWeek}</dd></div>
                                    <div><dt>Repeated mistakes</dt><dd>{p.repeatedMistakes}</dd></div>
                                </dl>
                            </Col>
                        </Card.Body>
                    </Card>
                </Col>
                </aside>
                <FormDialog model={() => state.correctOpen} title="Correct this memory" description="Your correction replaces the text and is recorded as stated by you." submitLabel="Save correction" onSubmit={confirmCorrect} onCancel={() => { state.correcting = null; }}>
                    <TextareaField model={() => state.correction} name="correction" label="Corrected text" rows={4} />
                </FormDialog>
                <ConfirmDialog model={() => state.deleteOpen} title="Delete this memory" description="Deleting removes it from every future session. Retire it instead to keep the history." dependents={state.deleting ? [state.deleting.text] : []} dependentsLabel="Deletes" confirmLabel="Delete memory" onConfirm={confirmDelete} />
            </div>
        );
    };
}, { name: 'MemoryTab' });
