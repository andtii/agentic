/**
 * Lanes (#1061, CHT-09, COL-09; `docs/design/chat-modes/HANDOFF.md` → "Lanes",
 * `docs/design/chat-modes/screenshots/ChatLanes.png`): pinned only — a row with the coordinator's latest
 * message, then an equal-width column per agent at work (`ai-lane`, #1057): its steps and messages in order
 * and a footer for its state, `Done · #22 ticked` or its open question with the answer buttons. More than
 * three lanes scroll sideways. Below 1024 px the page shows Team instead (`pick.ts`).
 *
 * A question the buttons cannot answer (free text, a form of several) offers `Answer in text`, which opens
 * the question card under its lane. What the model says comes from `model.ts`.
 */
import { component, onMounted, onUnmounted } from 'sigx';
import type { Decision } from '@sigx/ai-agent/app';
import { AgentTile, DENY_MESSAGE, Lane, QuestionPrompt, questionAnswers, questionFields, type LaneQuestion } from '@agentic/ui';
import type { ChatViewProps } from '../types';
import { ALLOW, DENY, lanesOf, lanesTopOf, type LaneAsk } from './model';

export type LanesViewProps = ChatViewProps;

/** Lanes side by side before the row scrolls. */
export const LANES_VISIBLE = 3;
/** The footer's way to a typed answer. */
export const ANSWER_IN_TEXT = 'Answer in text';
/** The composer's hint while Lanes shows. */
export const LANES_HINT = 'or @ an agent to post in its lane';

const GAP = 'var(--space-md)';

/** The decision a footer button sends. */
export function decisionOf(ask: LaneAsk, choice: string): Decision | undefined {
    if (ask.request.kind === 'permission') {
        return choice === ALLOW ? { type: 'permission', outcome: 'allow', scope: 'once' } : choice === DENY ? { type: 'permission', outcome: 'deny', scope: 'once', message: DENY_MESSAGE } : undefined;
    }
    if (!ask.choices.includes(choice)) return undefined;
    const answers = questionAnswers(questionFields(ask.request), [[choice]], ['']);
    return answers === undefined ? undefined : { type: 'input', answers };
}

export const LanesView = component<LanesViewProps>(({ props, signal }) => {
    // The lanes do not tick on their own (#1057): the view passes `now`, once a second.
    const st = signal({ now: Date.now(), answered: [] as string[], typing: [] as string[] });
    // onUnmounted registers during setup only: one called inside onMounted is dropped.
    let timer: ReturnType<typeof setInterval> | undefined;
    onMounted(() => {
        timer = setInterval(() => { st.now = Date.now(); }, 1000);
    });
    onUnmounted(() => clearInterval(timer));

    const settle = (requestId: string, out: unknown): void => {
        st.answered = [...st.answered, requestId];
        st.typing = st.typing.filter((id) => id !== requestId);
        // The answer never reached the session: the question comes back.
        if (out && typeof (out as Promise<unknown>).then === 'function') {
            void (out as Promise<unknown>).then(undefined, () => { st.answered = st.answered.filter((id) => id !== requestId); });
        }
    };
    const answer = (ask: LaneAsk, choice: string): void => {
        const id = ask.request.requestId;
        if (choice === ANSWER_IN_TEXT) {
            st.typing = st.typing.includes(id) ? st.typing.filter((x) => x !== id) : [...st.typing, id];
            return;
        }
        const decision = decisionOf(ask, choice);
        const respond = props.view.thread.onRespond;
        if (!decision || !respond) return;
        settle(id, respond(id, decision));
    };

    return () => {
        const v = props.view;
        const top = lanesTopOf(v);
        const lanes = lanesOf(v);
        const scrolls = lanes.length > LANES_VISIBLE;
        const row = scrolls
            ? { gridAutoFlow: 'column', gridAutoColumns: `calc((100% - ${LANES_VISIBLE - 1} * ${GAP}) / ${LANES_VISIBLE})`, overflowX: 'auto' }
            : { gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(0, 1fr))` };
        return (
            <div data-chat-lanes="" style={{ display: 'flex', flexDirection: 'column', gap: GAP, flex: '1 1 auto', minBlockSize: '0', minInlineSize: '0', padding: 'var(--space-lg) var(--space-2xl)', overflowY: 'auto' }}>
                {top ? (
                    <div data-chat-lanes-top={top.agentId} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', padding: 'var(--space-md) var(--space-lg)', border: 'var(--border) solid var(--ag-line)', borderRadius: 'var(--radius-box)', background: 'var(--color-base-200)', fontSize: 'var(--text-sm)', minInlineSize: '0' }}>
                        <AgentTile name={top.agent.name} hue={top.agent.hue} size={22} />
                        <strong data-chat-lanes-top-name="" style={{ flex: 'none' }}>{top.agent.name}</strong>
                        <span data-chat-lanes-top-text="" style={{ flex: '1 1 auto', minInlineSize: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={top.text}>{top.text}</span>
                        {top.time ? <time data-chat-lanes-top-time="" dateTime={top.time.dateTime} style={{ flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' }}>{top.time.text}</time> : null}
                    </div>
                ) : null}
                {lanes.length ? (
                    <div data-chat-lanes-row="" data-scroll={scrolls ? 'x' : undefined} role="list" aria-label="Lanes" style={{ display: 'grid', gap: GAP, flex: '1 1 auto', minBlockSize: '320px', ...row }}>
                        {lanes.map((l) => {
                            const ask = l.ask && !st.answered.includes(l.ask.request.requestId) ? l.ask : undefined;
                            const question: LaneQuestion | undefined = ask ? { text: `Asks you: ${ask.text}`, options: ask.choices.length ? ask.choices : [ANSWER_IN_TEXT] } : undefined;
                            const typing = ask && st.typing.includes(ask.request.requestId) ? ask : undefined;
                            return (
                                <div key={l.agentId} role="listitem" data-chat-lane={l.agentId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', minInlineSize: '0' }}>
                                    <div style={{ display: 'grid', gridTemplateRows: 'minmax(0, 1fr)', flex: '1 1 auto', minBlockSize: '0' }}>
                                        <Lane
                                            agent={l.agent}
                                            state={l.state}
                                            task={l.task}
                                            entries={l.entries}
                                            now={st.now}
                                            fullHref={v.stepHref}
                                            {...(l.startedAt !== undefined ? { startedAt: l.startedAt } : {})}
                                            {...(l.endedAt !== undefined ? { endedAt: l.endedAt } : {})}
                                            {...(l.done ? { done: l.done } : {})}
                                            {...(question && ask ? { question, onAnswer: (o: string) => answer(ask, o) } : {})}
                                        />
                                    </div>
                                    {typing ? (
                                        <div data-chat-lane-answer="">
                                            <QuestionPrompt request={typing.request} requestedBy={l.agent} onRespond={(id, decision) => {
                                                const out = v.thread.onRespond?.(id, decision);
                                                settle(id, out);
                                                return out;
                                            }} />
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p data-chat-lanes-empty="" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--ag-text-dim)' }}>No agent is at work: a lane opens when one starts.</p>
                )}
                <p data-chat-lanes-hint="" style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' }}>{LANES_HINT}</p>
            </div>
        );
    };
}, { name: 'ChatLanesView' });
