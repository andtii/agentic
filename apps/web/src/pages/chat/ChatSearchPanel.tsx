import { component, signal, type Define } from 'sigx';
import { Button } from '@agentic/ui';
import type { IndexedEntry } from '@agentic/platform';
import { entryLine, type AgentLookup, type TimeText } from './live';

/** Most hits asked for — `Chat.search`'s default. */
export const SEARCH_LIMIT = 20;

export type ChatSearchPanelProps =
    /** `Chat.search(q, limit)`: newest first, only what the caller may read (CHT-04). */
    & Define.Prop<'search', (q: string) => Promise<readonly IndexedEntry[]>, true>
    & Define.Prop<'lookup', AgentLookup, true>
    & Define.Prop<'time', TimeText, true>
    & Define.Event<'close'>;

/**
 * "Search this chat" (#152): a bar over the thread, the hits under it —
 * who, when, the line. Whole-history search is the Chat actor's
 * (`Chat.search`, archive pages included), so a hit may be older than what
 * the thread has loaded; the hit says when it was said.
 */
export const ChatSearchPanel = component<ChatSearchPanelProps>(({ props, emit }) => {
    const st = signal({ q: '', asked: '', busy: false, error: '', hits: [] as readonly IndexedEntry[] });
    const run = async (): Promise<void> => {
        const q = st.q.trim();
        if (!q || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            st.hits = await props.search(q);
            st.asked = q;
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    return () => (
        <section data-chat-find aria-label="Search this chat" style="display: flex; flex-direction: column; gap: var(--space-md); padding: var(--space-lg) var(--space-2xl); border-block-end: var(--border) solid var(--ag-line);">
            <form data-chat-search role="search" onSubmit={(e: Event) => { e.preventDefault(); void run(); }}>
                <label data-visually-hidden for="chat-find">Search this chat</label>
                <input id="chat-find" type="search" placeholder="Search this chat" data-scope="input" data-part="input" value={st.q} onInput={(e: Event) => { st.q = (e.target as HTMLInputElement).value; }} />
                <Button type="submit" disabled={st.busy || !st.q.trim()}>Search</Button>
                <Button intent="icon" icon="close" label="Close search" onClick={() => emit('close')} />
            </form>
            {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
            {st.asked ? (
                st.hits.length ? (
                    <ul data-chat-rows data-chat-hits aria-label={`Messages matching ${st.asked}`}>
                        {st.hits.map(({ seq, entry }) => (
                            <li data-chat-row data-chat-hit data-seq={seq}>
                                <span data-chat-row-line>
                                    <time data-member-more dateTime={new Date(entry.at).toISOString()}>{props.time(entry.at)}</time>
                                    <span data-chat-last>{entryLine(entry, props.lookup)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : <p data-panel-note>Nothing in this chat matches “{st.asked}”.</p>
            ) : null}
        </section>
    );
});
