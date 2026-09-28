/**
 * A crew strip over every chat view, for the Follow panel's page tests (#1060): the Team view (#1059) draws
 * the real one; until then (and independent of it) the tests put `@agentic/ui`'s `CrewStrip` above the view
 * the page picked, wired to `ChatViewModel.onFollow` exactly as a crew chip is.
 */
import { component } from 'sigx';
import { CrewStrip, type CrewMember } from '@agentic/ui';
import { CHAT_VIEWS, type ChatViewProps } from '../../src/pages/chat/views';

type Views = Record<keyof typeof CHAT_VIEWS, (typeof CHAT_VIEWS)[keyof typeof CHAT_VIEWS]>;

/** Wrap each registered view in one with a crew strip on top; returns the undo. */
export function withCrewStrip(): () => void {
    const views = CHAT_VIEWS as Views;
    const saved = { ...views };
    for (const name of Object.keys(saved) as (keyof Views)[]) {
        const Inner = saved[name];
        views[name] = component<ChatViewProps>(({ props }) => () => {
            const v = props.view;
            const members: CrewMember[] = v.members.map((m) => {
                const who = v.lookup(m.agentId);
                const live = v.live.find((w) => w.agentId === m.agentId);
                return { id: m.agentId, name: who.name, hue: who.hue, state: live ? 'working' : 'idle', ...(live?.step ? { step: live.step } : {}) };
            });
            return (
                <div data-test-crew>
                    <CrewStrip members={members} {...(v.followed ? { selected: v.followed } : {})} onFollow={(id: string) => v.onFollow(id)} />
                    <Inner view={v} />
                </div>
            );
        }, { name: `TestCrew_${name}` }) as unknown as typeof Inner;
    }
    return () => { Object.assign(views, saved); };
}

/** Click the crew chip of the agent called `name`. */
export function crewChip(dom: ParentNode, name: string): HTMLButtonElement {
    const chip = [...dom.querySelectorAll<HTMLButtonElement>('[data-scope="ai-crew"][data-part="chip"]')].find((b) => b.querySelector('[data-part="name"]')?.textContent === name);
    if (!chip) throw new Error(`no crew chip for ${name}`);
    return chip;
}
