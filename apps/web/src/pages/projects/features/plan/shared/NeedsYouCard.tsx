/**
 * The question a `needs-you` plan item waits on, and its answer (#1044): who asked, when and what — the item's `ask`
 * (#1043), else its last activity line for an item asked before it was recorded — the item's options as quick answers,
 * an answer box, **Answer & send back** (`Plan.answer`: the item is ready again and the asker is woken with the
 * answer) and **Mark done**. On the item's detail panel and on Home's Needs you.
 */
import { component, signal, type Define } from 'sigx';
import type { PlanActor, PlanItem } from '@agentic/core';
import { Button, ErrorNote, TextareaField } from '@agentic/ui';
import { formatAge } from '../../../../../mock/workspace';

/** The question as the card shows it: the recorded ask, else the newest activity line (an item asked before #1043). */
export function questionOf(item: PlanItem): { readonly by?: PlanActor; readonly text?: string; readonly at?: number } {
    if (item.ask) return { by: item.ask.by, ...(item.ask.text !== undefined ? { text: item.ask.text } : {}), at: item.ask.at };
    const last = item.activity.at(-1);
    return last ? { by: last.actor, text: last.text, at: last.at } : {};
}

export type NeedsYouCardProps =
    & Define.Prop<'item', PlanItem, true>
    & Define.Prop<'now', number, true>
    /** How an actor is named ("You", an agent's name). */
    & Define.Prop<'name', (a: PlanActor) => string, true>
    /** Send the answer; resolves whether it went. Absent, the card is read-only (mock data). */
    & Define.Prop<'onAnswer', (text: string) => Promise<boolean>>
    /** Mark the item done instead; resolves whether it went. */
    & Define.Prop<'onDone', () => Promise<boolean>>
    /** Why the last write was refused, from the host. */
    & Define.Prop<'error', string>;

export const NeedsYouCard = component<NeedsYouCardProps>(({ props }) => {
    const st = signal({ answer: '', busy: false });
    const run = async (write: () => Promise<boolean>, clear: boolean): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        try {
            if ((await write()) && clear) st.answer = '';
        } finally {
            // A write that throws never leaves the card stuck.
            st.busy = false;
        }
    };
    const answer = (e?: Event): void => {
        e?.preventDefault();
        const text = st.answer.trim();
        if (text && props.onAnswer) void run(() => props.onAnswer!(text), true);
    };
    return () => {
        const { item } = props;
        const q = questionOf(item);
        const who = q.by ? props.name(q.by) : 'Someone';
        const writable = !!props.onAnswer;
        return (
            <section data-plan-needs-you={item.id} aria-label={`#${item.id} needs you`}>
                <p data-plan-needs-you-who="">
                    <strong>{`${who} asks`}</strong>
                    {q.at !== undefined ? <span data-dim="">{formatAge(q.at, props.now)}</span> : null}
                </p>
                <p data-plan-needs-you-question="">{q.text ?? item.title}</p>
                {item.options?.length
                    ? (
                        <ul data-plan-needs-you-options="" aria-label="Options">
                            {item.options.map((o) => (
                                <li>
                                    <button type="button" data-plan-needs-you-option="" disabled={!writable || st.busy} title={o.detail} onClick={() => { st.answer = o.label; }}>{o.label}</button>
                                </li>
                            ))}
                        </ul>
                    )
                    : null}
                <form data-plan-needs-you-form="" onSubmit={answer}>
                    <TextareaField model={() => st.answer} name={`plan-answer-${item.id}`} label={`Your answer to #${item.id}`} rows={2} placeholder="Your answer. It goes to the agent that asked." disabled={!writable || st.busy} />
                    <div data-plan-needs-you-actions="">
                        <Button intent="primary" type="submit" disabled={!writable || st.busy || !st.answer.trim()} loading={st.busy}>Answer & send back</Button>
                        {props.onDone ? <Button intent="default" disabled={st.busy} onClick={() => void run(props.onDone!, false)}>Mark done</Button> : null}
                    </div>
                </form>
                {props.error ? <ErrorNote>{props.error}</ErrorNote> : null}
            </section>
        );
    };
}, { name: 'NeedsYouCard' });
