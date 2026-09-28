/**
 * Team (#1059, CHT-09, COL-09; `docs/design/chat-modes/HANDOFF.md` → "Team"): the view for two or more agents
 * at work — the crew strip under the header, one-line handoffs in place of the messages that created work, a
 * work card per agent per assignment (updated in place, never a line per step), agent-to-agent talk folded
 * into one divider, and questions for you with the assignment they block. The rows come from `model.ts`; the
 * thread shows the rest at the chat's detail level (Team's default is Messages).
 */
import { component, onMounted, onUnmounted } from 'sigx';
import { Button, CrewStrip, FoldedTalk, HandoffLine, QuestionPrompt, Thread, WorkCard, type ThreadInsert } from '@agentic/ui';
import type { ChatViewProps } from '../types';
import { teamRows, type TeamQuestion } from './model';

export type TeamViewProps = ChatViewProps;

/** How often the elapsed times tick while an agent works. */
const TICK_MS = 1000;

/** `blocks #23`: mono, dim, in the question card's top corner (the card's own header holds the title). */
const BLOCKS_STYLE = 'position: absolute; inset-block-start: var(--space-lg); inset-inline-end: var(--space-lg); font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ag-text-dim);';

export const TeamView = component<TeamViewProps>(({ props, signal }) => {
    const st = signal({ open: [] as string[], now: Date.now() });
    let timer: ReturnType<typeof setInterval> | undefined;
    onMounted(() => {
        timer = setInterval(() => {
            if (props.view.live.length) st.now = Date.now();
        }, TICK_MS);
    });
    onUnmounted(() => {
        if (timer) clearInterval(timer);
    });

    const toggleTalk = (key: string, open: boolean): void => {
        st.open = open ? [...st.open.filter((k) => k !== key), key] : st.open.filter((k) => k !== key);
    };

    /** Each question card's element, by request id: `Answer in text` focuses its text box. */
    const cards = new Map<string, HTMLElement>();
    const answerInText = (requestId: string): void => {
        cards.get(requestId)?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    };

    const questionRow = (q: TeamQuestion, v: ChatViewProps['view']) => () => {
        const who = q.agentId ? v.lookup(q.agentId) : undefined;
        const id = q.request.requestId;
        return (
            <div
                data-chat-team-question={id}
                style="position: relative; display: grid; gap: var(--space-sm); min-inline-size: 0;"
                ref={(el: HTMLElement | null) => {
                    if (el) cards.set(id, el);
                    else cards.delete(id);
                }}
            >
                <QuestionPrompt request={q.request} onRespond={v.thread.onRespond!} requestedBy={who ? { name: who.name, ...(who.hue ? { hue: who.hue } : {}) } : v.thread.describeRequest?.(q.request)?.requestedBy} />
                {q.blocks ? <span data-chat-team-blocks style={BLOCKS_STYLE}>blocks {q.blocks}</span> : null}
                <div data-chat-team-answer-text style="display: flex;">
                    <Button intent="default" onClick={() => answerInText(id)}>Answer in text</Button>
                </div>
            </div>
        );
    };

    return () => {
        const v = props.view;
        const now = Math.max(st.now, Date.now());
        const rows = teamRows(v, new Set(st.open));
        const shownIds = new Set(rows.messages.map((m) => m.id));
        const answered = new Set(rows.questions.map((q) => q.request.requestId));
        const requests = Object.fromEntries(Object.entries(v.thread.transcript.requests).filter(([id]) => !answered.has(id)));
        const transcript = { ...v.thread.transcript, messages: v.thread.transcript.messages.filter((m) => shownIds.has(m.id)), requests };
        const agent = (id: string) => {
            const a = v.lookup(id);
            return { name: a.name, ...(a.hue ? { hue: a.hue } : {}) };
        };
        const inserts: ThreadInsert[] = [
            ...(v.thread.inserts ?? []),
            ...rows.handoffs.map((h): ThreadInsert => ({
                key: `handoff:${h.key}`,
                at: h.at,
                render: () => (
                    <div data-chat-team-handoff={h.to}>
                        <HandoffLine from={agent(h.from)} to={agent(h.to)} task={h.task} {...(h.itemRef ? { itemRef: h.itemRef } : {})} />
                    </div>
                )
            })),
            ...rows.talk.map((t): ThreadInsert => {
                const open = st.open.includes(t.key);
                return {
                    key: `talk:${t.key}`,
                    at: open ? t.openAt : t.at,
                    render: () => (
                        <div data-chat-team-talk={t.key}>
                            <FoldedTalk names={t.names} count={t.messageIds.length} open={open} onToggle={(o: boolean) => toggleTalk(t.key, o)} />
                        </div>
                    )
                };
            }),
            ...rows.questions.map((q): ThreadInsert => ({ key: `question:${q.request.requestId}`, at: q.at, render: questionRow(q, v) })),
            ...rows.work.map((w): ThreadInsert => ({
                key: `work:${w.key}`,
                at: w.at,
                render: () => (
                    <div data-chat-team-work={w.key} data-chat-team-agent={w.agentId}>
                        <WorkCard
                            agent={agent(w.agentId)}
                            state={w.state}
                            task={w.task}
                            steps={w.steps}
                            stepCount={w.stepCount}
                            {...(w.startedAt !== undefined ? { startedAt: w.startedAt } : {})}
                            {...(w.endedAt !== undefined ? { endedAt: w.endedAt } : {})}
                            {...(w.result !== undefined ? { result: w.result } : {})}
                            now={now}
                            following={v.followed === w.agentId}
                            onFollow={() => v.onFollow(v.followed === w.agentId ? null : w.agentId)}
                            fullHref={v.stepHref}
                        />
                    </div>
                )
            }))
        ];
        return (
            <>
                <div data-chat-team-crew style="flex: none; padding: var(--space-lg) var(--space-2xl) var(--space-md); min-inline-size: 0;">
                    <CrewStrip members={rows.crew} {...(v.followed ? { selected: v.followed } : {})} now={now} onFollow={(id: string) => v.onFollow(id)} />
                </div>
                <Thread
                    {...v.thread}
                    transcript={transcript}
                    inserts={inserts}
                    detail={v.detail}
                    stepsOpen={v.stepsOpen}
                    onStepsToggle={v.onStepsToggle}
                    stepHref={v.stepHref}
                />
            </>
        );
    };
}, { name: 'ChatTeamView' });
