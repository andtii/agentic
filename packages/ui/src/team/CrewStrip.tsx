/**
 * `CrewStrip` and `CrewChip` — the crew under a Team chat's header (`ai-crew`, #1057, CHT-09;
 * `docs/design/chat-modes/HANDOFF.md` → "Team"): a 4-column grid with one chip per member that
 * scrolls sideways below 768 px. A chip's first line is the tile, the name, a state mark (a turning
 * ring while working, a dot otherwise) and the elapsed time; its second the current step, or
 * `asks you: …` while the member waits on you. Clicking a chip emits `follow` with the member's id;
 * the followed member's chip is selected.
 */
import { component, type Define } from '@sigx/runtime-core';
import { AgentTile } from '../kit/AgentTile.js';
import { aiCrewAnatomy } from './anatomy.js';
import { crewLifecycle, crewStateLabel, elapsedOf, type CrewMember } from './model.js';
import { markContent } from './StepList.js';

const SCOPE = aiCrewAnatomy.scope;

export type CrewChipProps =
    & Define.Prop<'member', CrewMember, true>
    & Define.Prop<'selected', boolean, false>
    /** The clock the elapsed time counts against; `Date.now()` by default. */
    & Define.Prop<'now', number, false>
    & Define.Prop<'onFollow', (id: string) => void, false>;

export const CrewChip = component<CrewChipProps>(({ props }) => () => {
    const m = props.member;
    const asks = m.state === 'needs-you' && m.ask !== undefined;
    return (
        <button
            type="button"
            data-scope={SCOPE}
            data-part="chip"
            data-state={crewLifecycle(m.state)}
            data-selected={props.selected ? '' : undefined}
            aria-pressed={props.selected ? 'true' : 'false'}
            onClick={() => props.onFollow?.(m.id)}
        >
            <AgentTile name={m.name} hue={m.hue} size={18} />
            <span data-scope={SCOPE} data-part="name">{m.name}</span>
            <span data-scope={SCOPE} data-part="mark" role="img" aria-label={crewStateLabel(m.state)}>{markContent(m.state === 'working')}</span>
            <span data-scope={SCOPE} data-part="elapsed">{elapsedOf(m.startedAt, m.endedAt, props.now ?? Date.now())}</span>
            {asks
                ? <span data-scope={SCOPE} data-part="ask" title={m.ask}>asks you: {m.ask}</span>
                : <span data-scope={SCOPE} data-part="step" title={m.step}>{m.step ?? ''}</span>}
        </button>
    );
}, { name: 'CrewChip' });

export type CrewStripProps =
    & Define.Prop<'members', readonly CrewMember[], true>
    /** The id of the member being followed: its chip is selected. */
    & Define.Prop<'selected', string, false>
    & Define.Prop<'now', number, false>
    & Define.Prop<'onFollow', (id: string) => void, false>;

export const CrewStrip = component<CrewStripProps>(({ props }) => () => (
    <div data-scope={SCOPE} data-part="root" role="group" aria-label="Crew">
        {props.members.map((m) => (
            <CrewChip key={m.id} member={m} selected={props.selected === m.id} now={props.now} onFollow={props.onFollow} />
        ))}
    </div>
), { name: 'CrewStrip' });
