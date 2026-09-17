import { component, signal, type Define } from 'sigx';
import { Card } from '@sigx/zero-daisyui/components';
import type { MemoryEntry, MemoryKind } from '@agentic/core';
import { Button, ConfirmDialog, EmptyState, Icon, Label, Stack, StatusPill, Switch, Tag, TextareaField } from '@agentic/ui';
import { MEMORY_KINDS, memoryCounts, type AgentProfile } from '../../mock/agents';
import { shortDate, dateTime } from './format';

export type MemoryTabProps = Define.Prop<'profile', AgentProfile, true>;

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
export function provenanceLine(entry: MemoryEntry): string {
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
    const when = Date.now() - p.at < 86_400_000 ? dateTime(p.at) : shortDate(p.at);
    return [who, ...refs, when].join(' · ');
}

/**
 * Memory: filter chips by kind with counts, the row grid
 * `110px 1fr 100px 120px` (kind tag, text + conditions + provenance,
 * confidence pill, actions), retired rows at 55 % with strikethrough and
 * the superseding reason; the rail lists scopes, what the runtime gets and
 * the learning counters (`docs/design/HANDOFF.md` → Agent memory).
 * Correct / retire / delete mutate the local copy until #41 wires the
 * Memory actor.
 */
export const MemoryTab = component<MemoryTabProps>(({ props }) => {
    const p = props.profile;
    const state = signal({
        filter: 'all' as Filter,
        entries: p.memories.map((e) => ({ ...e })) as MemoryEntry[],
        learning: p.learning,
        correcting: null as MemoryEntry | null,
        correction: '',
        deleting: null as MemoryEntry | null,
        correctOpen: false,
        deleteOpen: false
    });

    const visible = () => (state.filter === 'all' ? state.entries : state.entries.filter((e) => e.kind === state.filter));
    const update = (id: string, patch: Partial<MemoryEntry>) => {
        state.entries = state.entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    };
    const openCorrect = (entry: MemoryEntry) => {
        state.correcting = entry;
        state.correction = entry.text;
        state.correctOpen = true;
    };
    const confirmCorrect = () => {
        if (state.correcting) update(state.correcting.id, { text: state.correction.trim() || state.correcting.text, confidence: 'stated', provenance: { source: 'user', at: Date.now() } });
        state.correctOpen = false;
        state.correcting = null;
    };
    const retire = (entry: MemoryEntry) => update(entry.id, { retired: true, supersedes: `retired by you · ${dateTime(Date.now())}` });
    const openDelete = (entry: MemoryEntry) => {
        state.deleting = entry;
        state.deleteOpen = true;
    };
    const confirmDelete = () => {
        if (state.deleting) state.entries = state.entries.filter((e) => e.id !== state.deleting!.id);
        state.deleteOpen = false;
        state.deleting = null;
    };
    const exportHref = () => `data:application/x-ndjson;charset=utf-8,${encodeURIComponent(state.entries.map((e) => JSON.stringify(e)).join('\n'))}`;

    return () => {
        const counts = memoryCounts(state.entries);
        const chips: Filter[] = ['all', ...MEMORY_KINDS.filter((k) => counts[k] > 0)];
        const rows = visible();
        return (
            <div data-agent-memory="">
                <Stack gap="lg">
                    <div data-memory-toolbar="">
                        <div data-memory-filters="" role="group" aria-label="Filter by kind">
                            {chips.map((kind) => (
                                <button type="button" data-filter-chip="" data-kind={kind} aria-pressed={state.filter === kind ? 'true' : 'false'} onClick={() => { state.filter = kind; }}>
                                    <span>{KIND_LABELS[kind]}</span>
                                    <span data-filter-count="">{counts[kind]}</span>
                                </button>
                            ))}
                        </div>
                        <a data-memory-export="" href={exportHref()} download={`${p.config.name.toLowerCase()}-memory.ndjson`}>
                            <Icon name="download" size={15} />
                            <span>Export NDJSON</span>
                        </a>
                    </div>
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
                                                <p data-memory-superseded="">superseded by {e.supersedes ?? 'a later entry'}</p>
                                            ) : (
                                                <>
                                                    {e.conditions ? (
                                                        <p data-memory-conditions="">
                                                            <span>applies when</span>
                                                            {e.conditions.split('·').map((c) => <Tag>{c.trim()}</Tag>)}
                                                        </p>
                                                    ) : null}
                                                    <p data-memory-provenance="">{provenanceLine(e)}</p>
                                                </>
                                            )}
                                        </div>
                                        <span data-memory-confidence=""><StatusPill status={pill.status} label={pill.label} tone={pill.tone} hollow={pill.hollow} /></span>
                                        <span data-memory-actions="">
                                            <Button intent="icon" icon="edit" label="Correct this memory" disabled={!!e.retired} onClick={() => openCorrect(e)} />
                                            <Button intent="icon" icon="retire" label="Retire this memory" disabled={!!e.retired} onClick={() => retire(e)} />
                                            <Button intent="icon" icon="trash" label="Delete this memory" onClick={() => openDelete(e)} />
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <EmptyState variant="generic" title="No memories yet" caption="What this agent learns from sessions and your corrections shows up here." />
                    )}
                </Stack>
                <aside data-memory-rail="" aria-label="Memory settings">
                <Stack gap="lg">
                    <Card>
                        <Card.Body>
                            <Stack gap="sm">
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
                            </Stack>
                        </Card.Body>
                    </Card>
                    <Card>
                        <Card.Body>
                            <Stack gap="sm">
                                <Label>Supplied to the runtime</Label>
                                <p data-tone="muted">Up to 20 entries or 4 KB are retrieved per task and placed in the system prompt. Claude Code's own memory files are runtime-owned and not shown here.</p>
                            </Stack>
                        </Card.Body>
                    </Card>
                    <Card>
                        <Card.Body>
                            <Stack gap="sm">
                                <div data-learning-head="">
                                    <Label>Learning</Label>
                                    <Switch model={() => state.learning} label="Learn from sessions" hideLabel />
                                </div>
                                <p data-tone="muted">Memory writes are automatic. Instruction changes wait for your review.</p>
                                <dl data-learning-counters="">
                                    <div><dt>Corrections this week</dt><dd>{p.correctionsThisWeek}</dd></div>
                                    <div><dt>Repeated mistakes</dt><dd>{p.repeatedMistakes}</dd></div>
                                </dl>
                            </Stack>
                        </Card.Body>
                    </Card>
                </Stack>
                </aside>
                <ConfirmDialog model={() => state.correctOpen} title="Correct this memory" description="Your correction replaces the text and is recorded as stated by you." confirmLabel="Save correction" danger={false} onConfirm={confirmCorrect}>
                    <TextareaField model={() => state.correction} name="correction" label="Corrected text" rows={4} />
                </ConfirmDialog>
                <ConfirmDialog model={() => state.deleteOpen} title="Delete this memory" description="Deleting removes it from every future session. Retire it instead to keep the history." dependents={state.deleting ? [state.deleting.text] : []} dependentsLabel="Deletes" confirmLabel="Delete memory" onConfirm={confirmDelete} />
            </div>
        );
    };
}, { name: 'MemoryTab' });
