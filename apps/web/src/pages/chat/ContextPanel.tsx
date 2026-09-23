import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { memberWindows, type AccountRef, type EnvironmentId, type ProjectRecord, type QuotaWindow, type RuntimeId, type SessionOptionsPatch, type WorkdirRef } from '@agentic/core';
import { AgentTile, Button, ConfirmDialog, EnvironmentLine, Icon, Label, QuotaBadge, QuotaPanel, QuotaRings, StatusPill, WORKDIR_EMPTY, resetsShortText, ringWindows, workdirLabel, workdirPath, type WorkdirEnvironment } from '@agentic/ui';
import { memberQuota } from './quota';
import { DEFAULT_PERMISSION_MODE, modeChoices, modelChoices, type MemberChoice } from './member-options';
import { effectiveWorkdir } from '../projects/model';
import { WorkdirPicker } from '../workdir/WorkdirPicker';
import { agentNamed, formatTime, type MockChatSummary } from '../../mock/workspace';
import { stoppable, type AgentIdentity, type AgentLookup, type ChatTaskRow, type TimeText } from './live';

export type HistoryAccessChoice = 'all' | 'from';

export type ContextPanelProps =
    & Define.Prop<'chat', MockChatSummary, true>
    /** The mini-tree's rows: the mock workspace's task rows, or `chatTasks` over the task index (#152). */
    & Define.Prop<'tasks', readonly ChatTaskRow[], true>
    /** Who an agent id is; the mock workspace's `agentNamed` by default. */
    & Define.Prop<'lookup', AgentLookup>
    /** Agents of the workspace that are not members yet — the add-agent dialog's picker (#34). */
    & Define.Prop<'candidates', readonly AgentIdentity[]>
    /** `14:02` for an instant; the mock workspace's zone by default, the workspace's on the live page. */
    & Define.Prop<'time', TimeText>
    /** The add-agent dialog confirmed: `{ agentId, access }`. */
    & Define.Event<'addAgent', { readonly agentId: string; readonly access: HistoryAccessChoice }>
    /** "Stop task chain" confirmed. */
    & Define.Event<'stopChain'>
    /** Where a member's folder can be picked (#193); absent, the members show no folder. */
    & Define.Prop<'environments', readonly WorkdirEnvironment[]>
    /** The machine an environment belongs to — where the picker's folder requests go (live). */
    & Define.Prop<'machineOf', (environmentId: string) => string | undefined>
    /** The chat's project (#333): a member without its own folder runs in the project's folder for its environment. */
    & Define.Prop<'project', Pick<ProjectRecord, 'folders'>>
    /** The name of the chat's machine (`chat.machineId`, #414), for the rows. */
    & Define.Prop<'machineName', string>
    /** Whether a machine reports an environment (#414): a member's folder on another machine reads stale. */
    & Define.Prop<'hosted', (machineId: string, environmentId: string) => boolean>
    /** The environment of an account on a machine (#414): where an account-bound member runs on the chat's machine, for its quota and its folder. */
    & Define.Prop<'accountEnvironment', (machineId: string, runtime: RuntimeId, ref: AccountRef) => string | undefined>
    /** A member's folder for this chat was picked, or cleared with `null`. */
    & Define.Event<'setWorkdir', { readonly agentId: string; readonly ref: WorkdirRef | null }>
    /** "New session" confirmed for a member (#399): its session ends and the next message opens a fresh one; the chat's history stays. */
    & Define.Event<'resetSession', { readonly agentId: string }>
    /** A member's model or permission mode for this chat was picked, or cleared back to its config with `null` (#453). */
    & Define.Event<'setOptions', { readonly agentId: string; readonly patch: SessionOptionsPatch }>;

/** Which of a member's switchable rows is open (#453). */
type OptionKey = 'model' | 'permissionMode';

const OPTION_TITLE: Readonly<Record<OptionKey, string>> = { model: 'Model', permissionMode: 'Mode' };

const historyLine = (member: MockChatSummary['members'][number], time: TimeText): string => {
    const base = member.history.access === 'all' ? 'sees all history' : `Added ${time(member.history.at)} · sees history from then`;
    return member.coordinator ? `Coordinator · ${base}` : base.charAt(0).toUpperCase() + base.slice(1);
};

/** What a limit is called on the card (#452): `Session`, `Weekly`, the model a week is scoped to (`Fable`), else the provider's label. */
const limitName = (w: QuotaWindow): string => w.scope?.model ?? (w.period === 'session' ? 'Session' : w.period === 'week' ? 'Weekly' : w.label);

/**
 * The line under a member's rings once it is out: which limit, and when it opens again — `Fable limit · resets Thu
 * 12:00`. Only a window that limits the member's model counts (#452): another model's exhausted week is not its limit.
 * Picked by `status`, not utilization — a runtime can report an exhausted window with no number (Claude Code's limit message).
 */
const limitLine = (quota: ReturnType<typeof memberQuota>, model: string | undefined): string | undefined => {
    const w = quota.snapshot ? memberWindows(quota.snapshot, model).find((x) => x.status === 'exhausted') : undefined;
    if (!w) return undefined;
    const resets = resetsShortText(w.resetsAt, { date: false });
    return resets ? `${limitName(w)} limit · ${resets.charAt(0).toLowerCase()}${resets.slice(1)}` : `${limitName(w)} limit reached`;
};

/**
 * The chat's right column: the members as cards — name and status, then one
 * bordered group of rows in mono (where it runs, the folder it works in, the
 * model its config names), its usage as rings for the windows that limit its
 * model — the limit line under them once one is out, and "Details" opening the
 * account's full panel (#452) — and a footer with
 * its history access and "New session" (#399, confirmed before the member's
 * session is ended) — the tasks in this chat, "Stop task chain", and the
 * memory privacy note (MEM-11). The add-agent dialog asks for history access
 * (CHT-04). The folder, model and mode rows switch; the model and mode open a
 * listbox under the group and apply to the member's next turn (#453). The
 * environment follows the agent's config and the chat's machine.
 */
export const ContextPanel = component<ContextPanelProps>(({ props, emit }) => {
    const st = signal({ addAgent: false, stopChain: false, access: 'all' as HistoryAccessChoice, pick: '', picking: false, pickFor: '', resetFor: '', details: [] as readonly string[], optionFor: '', optionKey: 'model' as OptionKey, active: 0 });

    /** Open (or close) a member's model / mode listbox on the entry in effect. */
    const toggleOption = (agentId: string, key: OptionKey, choices: readonly MemberChoice[], current: string | undefined): void => {
        if (st.optionFor === agentId && st.optionKey === key) {
            st.optionFor = '';
            return;
        }
        st.optionFor = agentId;
        st.optionKey = key;
        st.active = Math.max(0, choices.findIndex((c) => c.id === current));
    };

    const choose = (agentId: string, key: OptionKey, id: string, current: string | undefined): void => {
        st.optionFor = '';
        if (id !== current) emit('setOptions', { agentId, patch: { [key]: id } });
    };

    /** The listbox's keys: arrows move, Enter / Space picks, Escape closes. */
    const onListKey = (e: KeyboardEvent, agentId: string, key: OptionKey, choices: readonly MemberChoice[], current: string | undefined): void => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            st.active = (st.active + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
        } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            st.active = e.key === 'Home' ? 0 : choices.length - 1;
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const c = choices[st.active];
            if (c) choose(agentId, key, c.id, current);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            st.optionFor = '';
        }
    };
    return () => {
        const root = props.tasks.find((t) => !t.parentId);
        const lookup = props.lookup ?? agentNamed;
        const candidates = props.candidates ?? [];
        const picked = candidates.find((c) => c.id === st.pick) ?? candidates[0];
        // What a stop would reach: a settled task is listed in the tree, never in the dialog.
        const running = stoppable(props.tasks);
        const resetting = st.resetFor ? lookup(st.resetFor).name : '';
        return (
            <aside data-chat-context aria-label="Members and tasks">
                <section data-context-section aria-label="Members">
                    <header data-context-head>
                        <Label>Members</Label>
                        <button type="button" data-link-button onClick={() => { st.addAgent = true; }}>Add agent</button>
                    </header>
                    <ul data-members>
                        {props.chat.members.map((member) => {
                            const a = lookup(member.agentId);
                            const machineId = props.chat.machineId;
                            // Where it runs on the chat's machine (#414): its account's environment there (or its pin, when that machine reports it) — the project's folder is read for that one.
                            const onMachine = machineId && a.environment.runtime !== 'anthropic-api' ? (a.account ? props.accountEnvironment?.(machineId, a.environment.runtime, a.account) : a.environmentId && props.hosted?.(machineId, a.environmentId) ? a.environmentId : undefined) : undefined;
                            // A folder picked on another machine is stale there (#414): the activation leaves it aside, the project's folder or the first root applies.
                            const stale = !!(member.workdir && machineId && props.hosted && !props.hosted(machineId, member.workdir.environmentId));
                            // The folder it runs in: its override for this chat, else the project's for its environment (#333).
                            const folder = effectiveWorkdir(stale ? { ...member, workdir: undefined } : member, onMachine ?? a.environmentId, props.project);
                            const environments = props.environments;
                            const quota = environments ? memberQuota(a, folder.ref?.environmentId, environments, machineId ? { machineId, ...(props.machineName ? { machineName: props.machineName } : {}), accountEnvironment: (m, r, ref) => props.accountEnvironment?.(m, r, ref) } : undefined) : undefined;
                            // The model it runs here: its override for this chat, else its config's (#450).
                            const model = member.options?.model ?? a.model;
                            // What its rows offer (#453): the models its environment's account reports, its runtime's modes.
                            const optionEnv = environments?.find((e) => e.id === (folder.ref?.environmentId ?? onMachine ?? a.environmentId));
                            const models = modelChoices(a.environment.runtime, optionEnv, model);
                            const modes = modeChoices(a.environment.runtime, optionEnv);
                            const mode = member.options?.permissionMode ?? DEFAULT_PERMISSION_MODE;
                            const optionRow = (key: OptionKey, icon: 'settings' | 'shield', value: string, choices: readonly MemberChoice[]) => {
                                const open = st.optionFor === member.agentId && st.optionKey === key;
                                const overridden = member.options?.[key] !== undefined;
                                return (
                                    <span data-member-row data-row={key === 'model' ? 'model' : 'mode'} data-member-option data-overridden={overridden ? '' : undefined}>
                                        <button
                                            type="button"
                                            data-member-option-open
                                            aria-expanded={open ? 'true' : 'false'}
                                            aria-controls={`member-${member.agentId}-${key}`}
                                            aria-label={`${OPTION_TITLE[key]} for ${a.name}: ${value}`}
                                            onClick={() => toggleOption(member.agentId, key, choices, value)}
                                        >
                                            <Icon name={icon} size={14} />
                                            <span data-member-row-value {...(key === 'model' ? { 'data-member-model': '' } : { 'data-member-mode': '' })}>{value}</span>
                                            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                                        </button>
                                        {overridden ? <button type="button" data-member-option-clear aria-label={`${OPTION_TITLE[key]} for ${a.name} back to its default`} title="Back to the agent's default" onClick={() => emit('setOptions', { agentId: member.agentId, patch: { [key]: null } })}><Icon name="close" size={14} /></button> : null}
                                    </span>
                                );
                            };
                            const openKey = st.optionFor === member.agentId ? st.optionKey : undefined;
                            const openChoices = openKey === 'model' ? models : openKey === 'permissionMode' ? modes : [];
                            const openValue = openKey === 'model' ? model : mode;
                            const listbox = openKey ? (
                                <div data-member-options id={`member-${member.agentId}-${openKey}`}>
                                    <span data-member-options-head>{OPTION_TITLE[openKey]} · applies to the next turn</span>
                                    <ul
                                        role="listbox"
                                        tabIndex={0}
                                        aria-label={`${OPTION_TITLE[openKey]} for ${a.name}`}
                                        aria-activedescendant={`member-${member.agentId}-${openKey}-${st.active}`}
                                        onKeydown={(e: KeyboardEvent) => onListKey(e, member.agentId, openKey, openChoices, openValue)}
                                        ref={(el: HTMLElement | null) => el?.focus()}
                                    >
                                        {openChoices.map((c, i) => (
                                            <li
                                                id={`member-${member.agentId}-${openKey}-${i}`}
                                                role="option"
                                                data-member-option-item
                                                data-active={i === st.active ? '' : undefined}
                                                aria-selected={c.id === openValue ? 'true' : 'false'}
                                                onClick={() => choose(member.agentId, openKey, c.id, openValue)}
                                            >
                                                <span data-member-option-check aria-hidden="true">{c.id === openValue ? <Icon name="check" size={12} /> : null}</span>
                                                <span data-member-option-label>{c.label}</span>
                                                {c.hint ? <span data-member-option-hint>{c.hint}</span> : null}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null;
                            const limit = quota ? limitLine(quota, model) : undefined;
                            const snapshot = quota?.snapshot;
                            const rings = !!snapshot && ringWindows(snapshot, model).length > 0;
                            const open = st.details.includes(member.agentId);
                            const details = snapshot?.windows.length ? (
                                <button type="button" data-member-details-toggle aria-expanded={open ? 'true' : 'false'} aria-label={`Usage details for ${a.name}`} onClick={() => { st.details = open ? st.details.filter((id) => id !== member.agentId) : [...st.details, member.agentId]; }}>
                                    Details <Icon name="chevron-down" size={12} />
                                </button>
                            ) : null;
                            return (
                                <li data-member>
                                    <header data-member-head>
                                        <AgentTile name={a.name} hue={a.hue} size={28} />
                                        <span data-member-who>
                                            <span data-member-name>{a.name}</span>
                                            <span data-member-role>{a.role}</span>
                                        </span>
                                        <StatusPill status={member.status === 'idle' ? 'idle' : member.status} />
                                    </header>
                                    <div data-member-rows>
                                        <span data-member-row data-row="environment">
                                            <Icon name="machines" size={14} />
                                            <EnvironmentLine tone="live" {...a.environment} />
                                        </span>
                                        {environments && a.environment.runtime !== 'anthropic-api' ? (
                                            <span data-member-row data-row="folder" data-member-workdir data-inherited={folder.inherited ? '' : undefined}>
                                                <button
                                                    type="button"
                                                    data-member-workdir-open
                                                    aria-label={`Working folder for ${a.name}: ${workdirLabel(folder.ref, environments)}`}
                                                    title={folder.ref ? workdirLabel(folder.ref, environments) : undefined}
                                                    onClick={() => { st.pickFor = member.agentId; st.picking = true; }}
                                                >
                                                    <Icon name="folder" size={14} />
                                                    <span data-member-row-value>
                                                        {folder.ref ? <span data-member-workdir-from>{folder.inherited ? 'project' : 'this chat'}</span> : null}
                                                        {folder.ref ? <span data-member-row-sep aria-hidden="true">·</span> : null}
                                                        <span data-member-workdir-path>{folder.ref ? workdirPath(folder.ref, environments) : WORKDIR_EMPTY}</span>
                                                    </span>
                                                    <Icon name="chevron-right" size={14} />
                                                </button>
                                                {member.workdir ? <button type="button" data-member-workdir-clear aria-label={`Use the project folder for ${a.name}`} title="Back to the project folder" onClick={() => emit('setWorkdir', { agentId: member.agentId, ref: null })}><Icon name="close" size={14} /></button> : null}
                                            </span>
                                        ) : null}
                                        {model || models.length ? optionRow('model', 'settings', model ? (models.find((c) => c.id === model)?.label ?? model) : 'runtime default', models) : null}
                                        {modes.length ? optionRow('permissionMode', 'shield', mode, modes) : null}
                                    </div>
                                    {listbox}
                                    {stale && member.workdir ? <span data-member-workdir-stale data-tone="dim">Folder {member.workdir.path} is on another machine — not used on {props.machineName ?? machineId}.</span> : null}
                                    {quota ? (
                                        <div data-member-usage data-limit={limit ? '' : undefined}>
                                            <span data-member-quota>{rings && snapshot ? <QuotaRings snapshot={snapshot} {...(model ? { model } : {})} /> : <QuotaBadge {...quota} {...(model ? { model } : {})} />}</span>
                                            {/* Under the rings (#470): the limit that ran out on the left, Details on the right. */}
                                            {limit || details ? <div data-member-usage-line>{limit ? <span data-member-limit title={limit}>{limit}</span> : <span aria-hidden="true" />}{details}</div> : null}
                                            {open && snapshot ? <div data-member-details><QuotaPanel snapshot={snapshot} zoneInHeader /></div> : null}
                                        </div>
                                    ) : null}
                                    <footer data-member-foot>
                                        <span data-member-history>{historyLine(member, props.time ?? formatTime)}</span>
                                        <button type="button" data-link-button data-member-reset aria-label={`New session for ${a.name}`} onClick={() => { st.resetFor = member.agentId; }}>New session</button>
                                    </footer>
                                </li>
                            );
                        })}
                    </ul>
                </section>

                <section data-context-section aria-label="Tasks in this chat">
                    <header data-context-head>
                        <Label>Tasks in this chat</Label>
                        {root ? <Link to={`/tasks/${root.id}`}>Open tree</Link> : null}
                    </header>
                    {props.tasks.length ? (
                        <ul data-mini-tree>
                            {props.tasks.map((t) => {
                                const a = lookup(t.agentId);
                                return (
                                    <li data-mini-node data-depth={t.depth} style={`--ag-depth: ${t.depth}`}>
                                        <span data-mini-dot data-tone={t.status === 'active' ? 'working' : t.status === 'waiting' ? 'needs-you' : 'muted'} aria-hidden="true" />
                                        <Link to={`/tasks/${t.id}`}>{t.objective}</Link>
                                        <AgentTile name={a.name} hue={a.hue} size={18} />
                                    </li>
                                );
                            })}
                        </ul>
                    ) : <p data-panel-note>No tasks yet.</p>}
                    {running.length ? <Button intent="danger" icon="stop" block onClick={() => { st.stopChain = true; }}>Stop task chain</Button> : null}
                </section>

                <p data-privacy-note>
                    <Icon name="shield" size={14} />
                    <span>Agents keep private memory here. Membership shares the chat, not their memories.</span>
                </p>

                {props.environments ? (
                    // Mounted closed from the start: a zero Dialog that mounts already open throws (signalxjs/zero#102).
                    <WorkdirPicker
                        model={() => st.picking}
                        title={st.pickFor ? `Working folder for ${lookup(st.pickFor).name}` : 'Working folder'}
                        // Opens on the folder in effect: the override, else the project's (#333).
                        value={(() => { const m = props.chat.members.find((x) => x.agentId === st.pickFor); return m ? effectiveWorkdir(m, lookup(m.agentId).environmentId, props.project).ref : null; })()}
                        environments={props.environments}
                        {...(props.machineOf ? { machineOf: props.machineOf } : {})}
                        // A daemon agent's identity names its default environment there (`identityOf`); anything else is ignored.
                        preferred={(st.pickFor ? lookup(st.pickFor).environment.machine : null) as EnvironmentId | null}
                        onSelect={(ref: WorkdirRef) => { st.picking = false; emit('setWorkdir', { agentId: st.pickFor, ref }); }}
                        onCancel={() => { st.picking = false; }}
                    />
                ) : null}
                <ConfirmDialog
                    model={() => st.addAgent}
                    title="Add an agent to this chat"
                    description="What may the agent read? Earlier messages are visible only if you allow all history (CHT-04)."
                    confirmLabel="Add agent"
                    danger={false}
                    onConfirm={() => {
                        st.addAgent = false;
                        if (picked) emit('addAgent', { agentId: picked.id, access: st.access });
                    }}
                >
                    {candidates.length ? (
                        <label data-agent-pick>
                            <span>Agent</span>
                            <select data-scope="select" data-part="select" value={picked?.id ?? ''} onChange={(e: Event) => { st.pick = (e.target as HTMLSelectElement).value; }}>
                                {candidates.map((c) => <option value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ''}</option>)}
                            </select>
                        </label>
                    ) : null}
                    <fieldset data-history-access>
                        <legend>History access</legend>
                        <label><input type="radio" name="history-access" value="all" checked={st.access === 'all'} onChange={() => { st.access = 'all'; }} /> All history</label>
                        <label><input type="radio" name="history-access" value="from" checked={st.access === 'from'} onChange={() => { st.access = 'from'; }} /> From now</label>
                    </fieldset>
                </ConfirmDialog>
                <ConfirmDialog
                    model={() => st.resetFor !== ''}
                    title={resetting ? `Start a new session for ${resetting}?` : 'Start a new session?'}
                    description={`${resetting || 'The agent'} forgets this conversation: its session ends and the next message opens a fresh one. Work it is doing right now stops. The chat's history stays.`}
                    confirmLabel="New session"
                    onConfirm={() => { const agentId = st.resetFor; st.resetFor = ''; if (agentId) emit('resetSession', { agentId }); }}
                    onCancel={() => { st.resetFor = ''; }}
                />
                <ConfirmDialog
                    model={() => st.stopChain}
                    title="Stop the task chain?"
                    description="The root stops at the next safe point and every child is told to stop. Children that do not acknowledge are listed as could not be stopped."
                    dependents={running.map((t) => t.objective)}
                    dependentsLabel={`Stops ${running.length} ${running.length === 1 ? 'task' : 'tasks'}`}
                    confirmLabel={`Stop ${running.length} ${running.length === 1 ? 'task' : 'tasks'}`}
                    onConfirm={() => { st.stopChain = false; emit('stopChain'); }}
                />
            </aside>
        );
    };
});
