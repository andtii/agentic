/**
 * "New email starts agent work" on a conduit connector's page, `/plugins/gmail`
 * (#535; AST-09, PLG-01 `trigger`). Drawn under the sign-in panel:
 *
 * - which agent each new email wakes, an optional Gmail search filter, how
 *   often to check (5 minutes at the least) and what to ask the agent;
 * - an on/off switch — off, nothing polls;
 * - why a poll paused it (the account needs reconnecting).
 *
 * The trigger is a Schedule entry that watches the connector
 * (`source: { kind: 'connector', connector }`): Save is
 * `Workspace.createSchedule` + `Schedule.create` the first time and
 * `Schedule.update` after, the switch `Schedule.enable` / `disable` — the
 * same calls /schedules makes, where the entry is listed too.
 */
import { component, signal, useData, watch, type Define, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { PluginView, ScheduleView } from '@agentic/platform';
import { Button, Label, SelectField, Switch, TextareaField, TextField } from '@agentic/ui';
import { useViewer, type ActorDefs } from '../../actors/defs';
import { scheduleKeyOf, workspaceKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { draftOf, triggerOf, triggerPatch, triggerSpec, triggerState, triggerText, TRIGGER_INTERVALS, validateTrigger, type TriggerDraft, type TriggerErrors, type TriggerState } from './connector-trigger';

export type ConnectorTriggerPanelProps =
    & Define.Prop<'name', string, true>
    & Define.Prop<'agents', readonly { value: string; label: string }[], true>
    /** The saved entry's draft, or a new one; the form resets to it when it changes. */
    & Define.Prop<'initial', TriggerDraft, true>
    & Define.Prop<'status', TriggerState, true>
    & Define.Prop<'busy', boolean>
    & Define.Prop<'notice', string>
    & Define.Prop<'error', string>
    & Define.Event<'save', TriggerDraft>
    & Define.Event<'toggle', boolean>;

const INTERVAL_OPTIONS = TRIGGER_INTERVALS.map((m) => ({ value: String(m), label: m === 60 ? 'Every hour' : `Every ${m} minutes` }));

export const ConnectorTriggerPanel = component<ConnectorTriggerPanelProps>(({ props, emit }) => {
    const st = signal<TriggerDraft & { attempted: boolean; on: boolean }>({ ...props.initial, attempted: false, on: props.status.state === 'on' });
    // The saved values: the form resets to them when they change (compared by value — the parent makes a new draft per render).
    watch(() => JSON.stringify(props.initial), () => Object.assign(st, props.initial, { attempted: false }));
    // The switch follows the entry.
    watch(() => props.status.state, (state) => { st.on = state === 'on'; });
    const draft = (): TriggerDraft => ({ agentId: st.agentId, query: st.query, interval: st.interval, prompt: st.prompt });
    return (): JSXElement => {
        const errors: TriggerErrors = st.attempted ? validateTrigger(draft()) : {};
        const s = props.status;
        const exists = s.state !== 'none';
        return (
            <section data-plugin-panel="trigger" aria-label={`New ${props.name} email`} data-trigger={s.state}>
                <Label>New email starts agent work</Label>
                <p data-plugin-hint>Each new email that matches the filter wakes the agent once, with its sender, subject and snippet; the agent reads the rest with its {props.name} tools, so give it {props.name} among its connectors.</p>
                <div data-trigger-status>
                    {exists
                        ? <Switch label={`Check ${props.name} for new email`} model={() => st.on} disabled={props.busy} onCheckedChange={(on: boolean) => emit('toggle', on)} />
                        : null}
                    <span data-trigger-text>{triggerText(s, props.name)}</span>
                </div>
                <div data-trigger-fields>
                    <SelectField model={() => st.agentId} name="trigger-agent" label="Agent" options={props.agents} placeholder="Pick an agent" required error={errors.agentId} />
                    <TextField model={() => st.query} name="trigger-query" label="Filter" placeholder="is:unread label:inbox" description="Gmail search syntax. Empty: every new message." error={errors.query} />
                    <SelectField model={() => st.interval} name="trigger-interval" label="Check" options={INTERVAL_OPTIONS} error={errors.interval} />
                    <TextareaField model={() => st.prompt} name="trigger-prompt" label="Ask the agent" rows={2} description="What to do with each email. Empty: handle it as its instructions say." />
                </div>
                <div data-trigger-actions>
                    <Button
                        intent="primary"
                        disabled={props.busy}
                        loading={props.busy}
                        onClick={() => {
                            st.attempted = true;
                            if (Object.keys(validateTrigger(draft())).length) return;
                            emit('save', draft());
                        }}
                    >{exists ? 'Save' : 'Turn on'}</Button>
                </div>
                {props.notice ? <p data-plugin-saved role="status">{props.notice}</p> : null}
                {props.error ? <p data-chat-error role="alert">{props.error}</p> : null}
            </section>
        );
    };
}, { name: 'ConnectorTriggerPanel' });

export type LiveConnectorTriggerProps =
    & Define.Prop<'plugin', PluginView, true>
    & Define.Prop<'workspaceId', string, true>
    & Define.Prop<'defs', ActorDefs, true>;

export const LiveConnectorTrigger = component<LiveConnectorTriggerProps>(({ props }) => {
    const viewer = useViewer()();
    const agents = useAgentDirectory(props.defs, viewer);
    const index = useActorState(props.defs.Workspace, () => [workspaceKeyOf(props.workspaceId), 'get'] as const, { live: true });
    const st = signal({ busy: false, notice: '', error: '', created: '' });
    // The entry that watches this connector: one `get` per schedule when the index changes (a handful per workspace).
    const found = useData(
        () => {
            const ids = index.value?.schedules;
            return ids ? (['connector-trigger', props.workspaceId, props.plugin.manifest.id, st.created, ...ids] as const) : false;
        },
        async (key): Promise<string | null> => {
            const [, ws, pluginId, , ...ids] = key as readonly string[];
            const views = await Promise.all(ids.map((id) => actor(props.defs.Schedule, scheduleKeyOf(ws!, id)).get().then((v) => v as ScheduleView, () => null)));
            return triggerOf(views, pluginId!)?.id ?? null;
        }
    );
    const scheduleId = (): string | null => st.created || found.value || null;
    const view = useActorState(props.defs.Schedule, () => { const id = scheduleId(); return id ? ([scheduleKeyOf(props.workspaceId, id), 'get'] as const) : false; }, { live: true });

    const run = async (what: () => Promise<void>, notice: string): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.error = '';
        st.notice = '';
        try {
            await what();
            st.notice = notice;
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };

    const save = (draft: TriggerDraft): void => {
        const m = props.plugin.manifest;
        const agentName = agents.lookup(draft.agentId).name;
        const id = scheduleId();
        void run(async () => {
            if (id) {
                const patch = triggerPatch(draft, m.id, m.name, agentName);
                if (!patch) throw new Error('The trigger is incomplete.');
                await actor(props.defs.Schedule, scheduleKeyOf(props.workspaceId, id)).update(patch);
                return;
            }
            const spec = triggerSpec(draft, m.id, m.name, agentName);
            if (!spec) throw new Error('The trigger is incomplete.');
            const { scheduleId: created } = await actor(props.defs.Workspace, workspaceKeyOf(props.workspaceId)).createSchedule();
            await actor(props.defs.Schedule, scheduleKeyOf(props.workspaceId, created)).create(spec);
            st.created = created;
        }, id ? 'Saved.' : `On. The first check runs within ${draft.interval} minutes.`);
    };

    const toggle = (on: boolean): void => {
        const id = scheduleId();
        if (!id) return;
        const client = actor(props.defs.Schedule, scheduleKeyOf(props.workspaceId, id));
        void run(async () => { await (on ? client.enable() : client.disable()); }, on ? 'On.' : 'Off — no more polls.');
    };

    return (): JSXElement => {
        const v = (scheduleId() ? view.value : undefined) ?? undefined;
        return (
            <ConnectorTriggerPanel
                name={props.plugin.manifest.name}
                agents={agents.all().map((a) => ({ value: a.id, label: a.name }))}
                initial={draftOf(v)}
                status={triggerState(v)}
                busy={st.busy}
                notice={st.notice}
                error={st.error}
                onSave={save}
                onToggle={toggle}
            />
        );
    };
}, { name: 'LiveConnectorTrigger' });
