/**
 * `Go to file` (#563): a search over the paths the caller knows (the tree's
 * loaded folders plus the changed files), matched as a subsequence and
 * ranked by where the match lands, as a combobox with a listbox. With
 * `hotkey`, Ctrl/Cmd+P focuses it from anywhere on the page.
 */
import { component, onMounted, onUnmounted, signal, type Define } from '@sigx/runtime-core';
import { Icon } from '../kit/icons.js';
import { agFindAnatomy } from './anatomy.js';
import { Kbd } from './parts.js';

const SCOPE = agFindAnatomy.scope;
/** At most this many matches are listed. */
export const FIND_MAX_RESULTS = 20;

let findCount = 0;

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
    & Define.Prop<'hotkey', boolean>;

export const GoToFile = component<GoToFileProps>(({ props }) => {
    const st = signal({ query: '', active: 0, open: false });
    const id = `ag-find-${++findCount}`;
    let input: HTMLInputElement | null = null;
    const onKey = (e: KeyboardEvent): void => {
        if (props.hotkey && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            input?.focus();
            input?.select();
        }
    };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));
    const pick = (path: string): void => {
        st.query = '';
        st.open = false;
        props.onPick(path);
    };
    return () => {
        const results = st.open ? findPaths(props.paths, st.query) : [];
        const active = Math.min(st.active, Math.max(0, results.length - 1));
        const shortcut = props.shortcut ?? 'Ctrl P';
        return (
            <div data-scope={SCOPE} data-part="root">
                <span data-scope={SCOPE} data-part="icon"><Icon name="search" size={14} /></span>
                <label for={id} data-visually-hidden="">Find file</label>
                <input
                    id={id}
                    type="search"
                    data-scope={SCOPE}
                    data-part="input"
                    placeholder={props.placeholder ?? 'Go to file'}
                    autoComplete="off"
                    role="combobox"
                    aria-expanded={results.length > 0 ? 'true' : 'false'}
                    aria-controls={`${id}-list`}
                    aria-activedescendant={results.length ? `${id}-${active}` : undefined}
                    value={st.query}
                    ref={(el: HTMLInputElement) => { input = el; }}
                    onInput={(e: Event) => {
                        st.query = (e.target as HTMLInputElement).value;
                        st.active = 0;
                        st.open = true;
                    }}
                    onBlur={() => setTimeout(() => { st.open = false; }, 120)}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === 'ArrowDown' && results.length) {
                            e.preventDefault();
                            st.active = (active + 1) % results.length;
                        } else if (e.key === 'ArrowUp' && results.length) {
                            e.preventDefault();
                            st.active = (active - 1 + results.length) % results.length;
                        } else if (e.key === 'Enter' && results[active]) {
                            e.preventDefault();
                            pick(results[active]!);
                        } else if (e.key === 'Escape') {
                            st.query = '';
                            st.open = false;
                        }
                    }}
                />
                {shortcut ? <Kbd keys={shortcut} /> : null}
                {results.length ? (
                    <ul data-scope={SCOPE} data-part="results" id={`${id}-list`} role="listbox" aria-label="Matching files">
                        {results.map((path, i) => (
                            <li
                                data-scope={SCOPE}
                                data-part="result"
                                id={`${id}-${i}`}
                                role="option"
                                aria-selected={i === active ? 'true' : 'false'}
                                onMouseDown={(e: MouseEvent) => {
                                    e.preventDefault();
                                    pick(path);
                                }}
                            >
                                {`\u200E${path}\u200E`}
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        );
    };
}, { name: 'GoToFile' });
