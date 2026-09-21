import { component, type Define } from 'sigx';
import { AgentTile, EnvironmentLine, Icon, QuotaBadge, type WorkdirEnvironment } from '@agentic/ui';
import type { AgentIdentity } from './live';
import { memberQuota, type QuotaMachine } from './quota';

export type MemberPickerProps =
    /** The workspace's agents to pick from. */
    & Define.Prop<'agents', readonly AgentIdentity[], true>
    /** The workspace's environments with their accounts' limits (#315): each card shows where its agent runs and the headroom there. */
    & Define.Prop<'environments', readonly WorkdirEnvironment[]>
    & Define.Prop<'picked', readonly string[], true>
    /** One of `picked`, or `''`. */
    & Define.Prop<'coordinator', string, true>
    /** Default "Members". */
    & Define.Prop<'legend', string>
    /** The environment a card's quota is read from on the chat's chosen machine (#414); absent, the agent's default. */
    & Define.Prop<'quotaEnvironmentOf', (agent: AgentIdentity) => string | undefined>
    /** The chosen machine itself (#414), so an account-bound agent with no login there says "Not signed in on <machine>". */
    & Define.Prop<'quotaMachine', QuotaMachine>
    & Define.Event<'toggle', { readonly id: string; readonly on: boolean }>
    & Define.Event<'pickCoordinator', string>;

/**
 * The member cards New chat and the project form share (#315, #333): each
 * card says where the agent runs (machine / runtime / account) and how
 * close that account is to its plan limits, so the person choosing who
 * works can see which one has headroom. A card is a label over a visually
 * hidden checkbox, so the keyboard and a screen reader get a plain
 * checkbox; the coordinator is a radio on the picked cards once there is a
 * group.
 */
export const MemberPicker = component<MemberPickerProps>(({ props, emit }) => () => {
    const group = props.picked.length > 1;
    return (
        <fieldset data-new-chat-members data-new-chat-grid>
            <legend>{props.legend ?? 'Members'}</legend>
            {props.agents.length ? props.agents.map((a) => {
                const picked = props.picked.includes(a.id);
                return (
                    <div key={a.id} data-new-chat-agent={a.id} data-picked={picked ? '' : undefined}>
                        <label data-new-chat-pick>
                            <input data-visually-hidden type="checkbox" name="member" value={a.id} checked={picked} onChange={(e: Event) => emit('toggle', { id: a.id, on: (e.target as HTMLInputElement).checked })} />
                            <span data-new-chat-head>
                                <AgentTile name={a.name} hue={a.hue} size={32} />
                                <span data-new-chat-who>
                                    <span data-new-chat-name>{a.name}</span>
                                    {a.role ? <span data-member-role>{a.role}</span> : null}
                                </span>
                                <span data-new-chat-check aria-hidden="true">{picked ? <Icon name="check" size={12} /> : null}</span>
                            </span>
                            <EnvironmentLine tone="muted" {...a.environment} />
                            {props.environments ? <span data-new-chat-quota><QuotaBadge {...memberQuota(a, props.quotaEnvironmentOf?.(a), props.environments, props.quotaMachine)} /></span> : null}
                        </label>
                        {picked && group ? (
                            <label data-new-chat-coordinator-pick>
                                <input type="radio" name="coordinator" value={a.id} checked={props.coordinator === a.id} onChange={() => emit('pickCoordinator', a.id)} />
                                <span>Coordinator</span>
                            </label>
                        ) : null}
                    </div>
                );
            }) : <p data-panel-note>No agents yet — create one under Agents first.</p>}
        </fieldset>
    );
});
