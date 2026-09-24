/**
 * `Go to file` (#563): a search over the paths the caller knows (the tree's
 * loaded folders plus the changed files), matched as a subsequence and
 * ranked by where the match lands. zero's `Combobox` (#587) over the ranked
 * paths, windowed (`virtual={virtualListbox}`) so a large folder keeps a
 * page of options in the DOM. With `hotkey`, Ctrl/Cmd+P focuses it from
 * anywhere on the page.
 */
import { component, onMounted, onUnmounted, signal, type Define } from '@sigx/runtime-core';
import { Combobox, Field } from '@sigx/zero';
import { virtualListbox } from '@sigx/zero/virtual-listbox';
import { Icon } from '../kit/icons.js';
import { agFindAnatomy } from './anatomy.js';
import { Kbd } from './parts.js';

const SCOPE = agFindAnatomy.scope;
/** `findPaths`' default limit. `GoToFile` lists every match, windowed. */
export const FIND_MAX_RESULTS = 20;

/**
 * A match score for `query` in `path` (higher is better), or -1 for none:
 * a subsequence match, better when it falls in the file name, is contiguous
 * and starts early.
 */
export function matchScore(path: string, query: string): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    const p = path.toLowerCase();
    const nameStart = p.lastIndexOf('/') + 1;
    let score = 0;
    let at = -1;
    let run = 0;
    for (const ch of q) {
        const next = p.indexOf(ch, at + 1);
        if (next < 0) return -1;
        run = next === at + 1 ? run + 1 : 0;
        score += 1 + run * 2 + (next >= nameStart ? 3 : 0);
        at = next;
    }
    if (p.slice(nameStart).startsWith(q)) score += 20;
    return score - p.length / 100;
}

/** The best `limit` matches of `query` among `paths`. */
export function findPaths(paths: readonly string[], query: string, limit = FIND_MAX_RESULTS): string[] {
    if (!query.trim()) return [];
    return paths
        .map((path) => ({ path, score: matchScore(path, query) }))
        .filter((m) => m.score >= 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, limit)
        .map((m) => m.path);
}

export type GoToFileProps =
    & Define.Prop<'paths', readonly string[], true>
    & Define.Prop<'onPick', (path: string) => void, true>
    & Define.Prop<'placeholder', string>
    /** The hint shown at the end (`Ctrl P`); empty hides it. */
    & Define.Prop<'shortcut', string>
    /** Focus on Ctrl/Cmd+P anywhere on the page. */
    & Define.Prop<'hotkey', boolean>
    /** The search's id, on its root; default `ag-find` (one per page). The input's and the list's ids are zero's. */
    & Define.Prop<'id', string>;

export const GoToFile = component<GoToFileProps>(({ props }) => {
    const st = signal({ query: '', value: null as string | null });
    let root: HTMLElement | null = null;
    const input = (): HTMLInputElement | null => root?.querySelector<HTMLInputElement>('[data-scope="combobox"][data-part="input"]') ?? null;
    const onKey = (e: KeyboardEvent): void => {
        if (props.hotkey && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            input()?.focus();
            input()?.select();
        }
    };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));
    const pick = (path: string | null): void => {
        if (!path) return;
        props.onPick(path);
        // After the Combobox has written the label into the input: a pick leaves an empty search.
        queueMicrotask(() => {
            st.value = null;
            st.query = '';
        });
    };
    /** Every match, best first; with no query, every path (the list is windowed). */
    const items = (): readonly string[] => (st.query.trim() ? findPaths(props.paths, st.query, Number.POSITIVE_INFINITY) : props.paths);
    return () => {
        const shortcut = props.shortcut ?? 'Ctrl P';
        return (
            <div data-scope={SCOPE} data-part="root" id={props.id ?? 'ag-find'} ref={(el: HTMLElement) => { root = el; }}>
                <span data-scope={SCOPE} data-part="icon"><Icon name="search" size={14} /></span>
                <Field.Root>
                    <Field.Label visuallyHidden>Find file</Field.Label>
                    <Combobox.Root
                        items={items()}
                        filter={false}
                        virtual={virtualListbox}
                        estimateItemSize={30}
                        model={() => st.value}
                        model:inputValue={() => st.query}
                        placeholder={props.placeholder ?? 'Go to file'}
                        onValueChange={pick}
                        slots={{ item: ({ item }: { item: string }) => `‎${item}‎` }}
                    />
                </Field.Root>
                {shortcut ? <Kbd keys={shortcut} /> : null}
            </div>
        );
    };
}, { name: 'GoToFile' });
