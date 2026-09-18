/**
 * `QuestionPrompt` — an open input request as a question card: what the
 * agent asks and the answer box, one component everywhere (under the tool
 * call that asked, in the Home inbox), like `ApprovalPrompt` is for
 * permissions.
 *
 * A request with a `schema` is a form — Claude Code's `AskUserQuestion`
 * raises one property per question (`q1`, `q2`, …) with the options as an
 * `enum` and a multi-select as an array — and is answered with an object
 * keyed by those properties: the runtime reads nothing else, and reports
 * "The user did not answer the questions." for a bare string. Each question
 * renders its options as toggles plus a free-text "Other" that wins over a
 * single choice and joins a multi-select. A request without a form (the
 * platform's `ask_user`) has one question: its `message`, its `options` as
 * choices, and the answer goes out as the text.
 *
 * Between the click and the ack the card disables; a rejection re-enables
 * it with the reason; once the caller passes `answered` it collapses to the
 * one-line record.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { OpenRequest } from '@sigx/ai-agent/app';
import { Button } from '../kit/Button.js';
import { Icon } from '../kit/icons.js';
import type { ApprovalRequester, RespondFn } from './ApprovalPrompt.js';
import { aiQuestionAnatomy } from './anatomy.js';
import { nonBlank } from './text.js';

const SCOPE = aiQuestionAnatomy.scope;

/** One question of the card, from the request's form or from the request itself. */
export interface QuestionField {
    /** The form property it answers under; `undefined` for a request without a form (the answer is the text). */
    readonly key?: string;
    /** The short header — `Focus`. */
    readonly label?: string;
    /** The question — `What kind of improvement do you want?`. */
    readonly prompt?: string;
    readonly choices: readonly { readonly label: string; readonly hint?: string }[];
    readonly multi: boolean;
}

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** The `enum` of a value schema, directly or in an `anyOf` branch. */
function enumOf(schema: unknown): string[] {
    if (!isObject(schema)) return [];
    if (Array.isArray(schema.enum)) return schema.enum.filter((v): v is string => typeof v === 'string');
    if (Array.isArray(schema.anyOf)) return schema.anyOf.flatMap(enumOf);
    return [];
}

/** The card's questions: one per form property, or the request's own message and options when it carries no form. */
export function questionFields(request: OpenRequest): QuestionField[] {
    const properties = isObject(request.schema) && isObject(request.schema.properties) ? request.schema.properties : undefined;
    const keys = properties ? Object.keys(properties) : [];
    if (!properties || keys.length === 0) {
        return [{ prompt: nonBlank(request.message), choices: (request.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { hint: o.description } : {}) })), multi: false }];
    }
    return keys.map((key, i) => {
        const p = isObject(properties[key]) ? (properties[key] as JsonObject) : {};
        const multi = p.type === 'array';
        const labels = enumOf(multi ? p.items : p);
        // The request's flat options carry each choice's description as `q{n}:{label}` (the adapter's `questionOptions`).
        const hints = new Map((request.options ?? []).filter((o) => o.id.startsWith(`${key}:`) || o.id.startsWith(`q${i + 1}:`)).map((o) => [o.label, o.description]));
        return {
            key,
            ...(text(p.title) ? { label: p.title as string } : {}),
            ...(text(p.description) ? { prompt: p.description as string } : {}),
            choices: labels.map((label) => {
                const hint = hints.get(label);
                return { label, ...(hint ? { hint } : {}) };
            }),
            multi
        };
    });
}

/** One question's answer from what is chosen and typed: the free text wins over a single choice and joins a multi-select. */
function answerOf(field: QuestionField, chosen: readonly string[], other: string): string | string[] | undefined {
    const typed = other.trim();
    if (field.multi) {
        const all = typed ? [...chosen, typed] : [...chosen];
        return all.length ? all : undefined;
    }
    return typed || chosen[0] || undefined;
}

/** The answers as `respond` takes them: keyed by property for a form, the text itself without one; `undefined` while nothing is answered. */
export function questionAnswers(fields: readonly QuestionField[], chosen: readonly (readonly string[])[], other: readonly string[]): unknown {
    const answers = fields.map((f, i) => answerOf(f, chosen[i] ?? [], other[i] ?? ''));
    if (fields.length === 1 && fields[0]!.key === undefined) return answers[0];
    const out: Record<string, string | string[]> = {};
    fields.forEach((f, i) => {
        const a = answers[i];
        if (f.key !== undefined && a !== undefined) out[f.key] = a;
    });
    return Object.keys(out).length ? out : undefined;
}

/** How an answer reads back in one line: `Clear the open bugs · small, medium`. */
export function answerText(answers: unknown): string {
    if (typeof answers === 'string') return answers;
    if (Array.isArray(answers)) return answers.map(String).join(', ');
    if (isObject(answers)) return Object.values(answers).map(answerText).filter((s) => s !== '').join(' · ');
    return answers === undefined || answers === null ? '' : JSON.stringify(answers);
}

export type QuestionPromptProps =
    & Define.Prop<'request', OpenRequest, true>
    & Define.Prop<'onRespond', RespondFn, true>
    & Define.Prop<'requestedBy', ApprovalRequester, false>
    /** The answer that settled the request (from this or another client): the card collapses to it. */
    & Define.Prop<'answered', unknown, false>
    /** Settled as cancelled rather than answered. */
    & Define.Prop<'cancelled', boolean, false>;

export const QuestionPrompt = component<QuestionPromptProps>(({ props, signal }) => {
    const st = signal({ chosen: [] as string[][], other: [] as string[], pending: false, error: '' });

    const toggle = (index: number, field: QuestionField, label: string): void => {
        const current = st.chosen[index] ?? [];
        const next = field.multi ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : current[0] === label ? [] : [label];
        const chosen = [...st.chosen];
        chosen[index] = next;
        st.chosen = chosen;
    };

    const type = (index: number, value: string): void => {
        const other = [...st.other];
        other[index] = value;
        st.other = other;
    };

    /** The answer never reached the session: say so and let the user try again. */
    const failed = (e: unknown): void => {
        st.pending = false;
        st.error = e instanceof Error ? e.message : String(e);
    };

    const submit = (): void => {
        if (st.pending) return;
        const answers = questionAnswers(questionFields(props.request), st.chosen, st.other);
        if (answers === undefined) return;
        st.pending = true;
        st.error = '';
        let out: unknown;
        try {
            out = props.onRespond(props.request.requestId, { type: 'input', answers });
        } catch (e) {
            failed(e);
            return;
        }
        if (out && typeof (out as Promise<unknown>).then === 'function') void (out as Promise<unknown>).then(undefined, failed);
    };

    return () => {
        const fields = questionFields(props.request);
        const who = props.requestedBy;
        const settled = props.answered !== undefined || props.cancelled;
        const ready = questionAnswers(fields, st.chosen, st.other) !== undefined;
        return (
            <div data-scope={SCOPE} data-part="root" role="group" aria-label={`Question${who ? ` from ${who.name}` : ''}`} aria-live={settled ? undefined : 'polite'}>
                <div data-scope={SCOPE} data-part="header">
                    <Icon name="chats" size={15} />
                    <span data-scope={SCOPE} data-part="title">{settled ? 'Question' : `${who ? `${who.name} asks` : 'Question'}`}</span>
                </div>
                {settled ? (
                    <p data-scope={SCOPE} data-part="record">{props.cancelled ? 'Not answered (cancelled)' : `Answered: ${answerText(props.answered)}`}</p>
                ) : (
                    <>
                        {fields.map((field, i) => (
                            <fieldset key={field.key ?? 'q'} data-scope={SCOPE} data-part="question" disabled={st.pending}>
                                {field.label ? <legend data-scope={SCOPE} data-part="label">{field.label}</legend> : null}
                                {field.prompt ? <p data-scope={SCOPE} data-part="prompt">{field.prompt}</p> : null}
                                {field.choices.length ? (
                                    // Toggle buttons in a labelled group: radio / checkbox roles would promise arrow-key navigation the card does not implement.
                                    <div data-scope={SCOPE} data-part="options" role="group" aria-label={`${field.label ?? field.prompt ?? 'Answer'}${field.multi ? ' (choose any)' : ' (choose one)'}`}>
                                        {field.choices.map((c) => {
                                            const on = (st.chosen[i] ?? []).includes(c.label);
                                            return (
                                                <button
                                                    type="button"
                                                    data-scope={SCOPE}
                                                    data-part="option"
                                                    data-state={on ? 'on' : 'off'}
                                                    aria-pressed={on ? 'true' : 'false'}
                                                    disabled={st.pending}
                                                    onClick={() => toggle(i, field, c.label)}
                                                >
                                                    <strong>{c.label}</strong>
                                                    {c.hint ? <span data-scope={SCOPE} data-part="hint">{c.hint}</span> : null}
                                                </button>
                                            );
                                        })}
                                    </div>
                                ) : null}
                                <textarea
                                    data-scope={SCOPE}
                                    data-part="other"
                                    rows={2}
                                    aria-label={field.choices.length ? `Other answer${field.label ? ` to ${field.label}` : ''}` : `Your answer${field.label ? ` to ${field.label}` : ''}`}
                                    placeholder={field.choices.length ? 'Or write your own answer…' : 'Your answer…'}
                                    value={st.other[i] ?? ''}
                                    disabled={st.pending}
                                    onInput={(e: Event) => type(i, (e.target as HTMLTextAreaElement).value)}
                                />
                            </fieldset>
                        ))}
                        {st.error ? <p data-scope={SCOPE} data-part="error" role="alert">{`Could not answer: ${st.error}`}</p> : null}
                        <div data-scope={SCOPE} data-part="actions">
                            <Button intent="wait" icon="check" loading={st.pending} disabled={st.pending || !ready} onClick={submit}>
                                Answer
                            </Button>
                        </div>
                    </>
                )}
            </div>
        );
    };
}, { name: 'QuestionPrompt' });
