/**
 * `FileTree` — a lazily loaded folder tree (#563, `Files` board, left 300 px),
 * on zero's `TreeView` (#587): the APG tree — roving focus, arrow keys,
 * typeahead, `aria-level` from the nesting — is zero's; this file adds only
 * the lazy loading and the product row.
 *
 * Generic: it knows core's `FsTreeEntry` and a `load(path)` function, never
 * where the entries come from. A folder loads when it is expanded
 * (`expandedValuesChange`), its children render once they arrive; the
 * ancestors of `selected` are expanded on mount so a deep link lands on its
 * file.
 *
 * Every row is an `ag-file-tree` `item` rendered `asChild` over TreeView's
 * part (it carries the part's role, state and handlers): the handoff's row —
 * 28 px, mono 12, the selection on `base-300`, the change dot — is product
 * look, not the design system's tree row, and the pages address rows by it.
 * (A nested folder's typeahead text is its path, not its name, until zero
 * reads an `asChild` trigger's own text — signalxjs/zero#157.)
 */
import { component, onMounted, signal, type Define, type JSXElement } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import { TreeView } from '@sigx/zero';
import type { FileChangeStatus, FsTreeEntry } from '@agentic/core';
import { Icon } from '../kit/icons.js';
import { agFileTreeAnatomy } from './anatomy.js';
import { changeDotTone } from './parts.js';

const SCOPE = agFileTreeAnatomy.scope;

/** A folder's entries, or why it has none to show. */
export type FileTreeLoad = (path: string) => Promise<readonly FsTreeEntry[]>;

interface FolderState {
    entries?: readonly FsTreeEntry[];
    loading?: boolean;
    error?: string;
}

/** The folders on the way to `path` (`a/b/c.ts` → `a`, `a/b`). */
export function ancestorsOf(path: string): string[] {
    const parts = path.split('/').filter(Boolean);
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** The folder holding `path` (`''` at the top). */
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export type FileTreeProps =
    & Define.Prop<'load', FileTreeLoad, true>
    /** The open file's path. */
    & Define.Prop<'selected', string>
    /** A file was chosen (click, Enter). */
    & Define.Prop<'onSelect', (entry: FsTreeEntry) => void, true>
    /** Override the change a row shows (default: the entry's own `change`). */
    & Define.Prop<'changeOf', (entry: FsTreeEntry) => FileChangeStatus | undefined>
    & Define.Prop<'label', string>
    /** Bump to drop every loaded folder and load again (a refresh). */
    & Define.Prop<'version', number>;

export const FileTree = component<FileTreeProps>(({ props }) => {
    const st = signal({ folders: {} as Record<string, FolderState>, expanded: [] as string[], selected: props.selected ?? '' });

    const loadFolder = (path: string): void => {
        const folder = st.folders[path];
        if (folder?.entries || folder?.loading) return;
        st.folders[path] = { loading: true };
        props.load(path).then(
            (entries) => { st.folders[path] = { entries }; },
            (error: unknown) => { st.folders[path] = { error: error instanceof Error ? error.message : String(error) }; }
        );
    };
    const expand = (dirs: readonly string[]): void => {
        const next = dirs.filter((d) => !st.expanded.includes(d));
        if (next.length) st.expanded = [...st.expanded, ...next];
        for (const dir of dirs) loadFolder(dir);
    };
    const openTo = (path: string | undefined): void => {
        loadFolder('');
        expand(ancestorsOf(path ?? ''));
    };
    onMounted(() => openTo(props.selected));
    watch(() => props.selected, (path) => {
        st.selected = path ?? '';
        openTo(path);
    });
    watch(() => props.version, () => {
        st.folders = {};
        loadFolder('');
        for (const dir of st.expanded) loadFolder(dir);
    });

    const entryAt = (path: string): FsTreeEntry | undefined => st.folders[parentOf(path)]?.entries?.find((e) => e.path === path);

    /** A selection write: a file is picked; a folder (Enter on its row) opens or closes instead, the file stays selected. */
    const onValueChange = (path: string): void => {
        const entry = entryAt(path);
        if (entry?.type === 'file') {
            props.onSelect(entry);
            return;
        }
        st.selected = props.selected ?? '';
        if (entry) st.expanded = st.expanded.includes(path) ? st.expanded.filter((d) => d !== path) : [...st.expanded, path];
        for (const dir of st.expanded) loadFolder(dir);
    };

    const row = (entry: FsTreeEntry, p: Record<string, unknown>, isDir: boolean): JSXElement => {
        const change = props.changeOf ? props.changeOf(entry) : entry.change;
        return (
            <div {...p} data-scope={SCOPE} data-part="item" data-type={isDir ? 'dir' : 'file'} data-path={entry.path} title={entry.path}>
                {isDir
                    ? <TreeView.BranchIndicator><Icon name="chevron-right" size={12} /></TreeView.BranchIndicator>
                    : <span data-scope={SCOPE} data-part="toggle" aria-hidden="true" />}
                <span data-scope={SCOPE} data-part="icon" aria-hidden="true"><Icon name={isDir ? 'folder' : 'file'} size={14} /></span>
                <span data-scope={SCOPE} data-part="name">{entry.name}</span>
                {change ? <span data-scope={SCOPE} data-part="dot" data-tone={changeDotTone(change)} role="img" aria-label={change} /> : null}
            </div>
        );
    };

    const renderFolder = (dir: string): JSXElement[] => {
        const folder = st.folders[dir];
        if (!folder || folder.loading) return [<p data-scope={SCOPE} data-part="status" role="none">Loading…</p>];
        if (folder.error) return [<p data-scope={SCOPE} data-part="status" role="none">{folder.error}</p>];
        return (folder.entries ?? []).map((entry) => entry.type === 'dir'
            ? (
                <TreeView.Branch value={entry.path} key={entry.path}>
                    <TreeView.BranchTrigger asChild>{(p: Record<string, unknown>) => row(entry, p, true)}</TreeView.BranchTrigger>
                    <TreeView.BranchContent>
                        {st.expanded.includes(entry.path) || st.folders[entry.path] ? renderFolder(entry.path) : null}
                    </TreeView.BranchContent>
                </TreeView.Branch>
            )
            : <TreeView.Item value={entry.path} key={entry.path} asChild>{(p: Record<string, unknown>) => row(entry, p, false)}</TreeView.Item>);
    };

    return () => (
        <TreeView.Root
            model={() => st.selected}
            model:expandedValues={() => st.expanded}
            onValueChange={onValueChange}
            onExpandedValuesChange={(dirs: string[]) => { for (const dir of dirs) loadFolder(dir); }}
        >
            <TreeView.Label data-visually-hidden="">{props.label ?? 'Files'}</TreeView.Label>
            <TreeView.Tree>{renderFolder('')}</TreeView.Tree>
        </TreeView.Root>
    );
}, { name: 'FileTree' });

export type FileTreeLegendProps =
    /** The folder listing left out ignored files (`.gitignore hidden`). */
    & Define.Prop<'ignoredHidden', boolean>
    & Define.Prop<'ignoreLabel', string>;

/** The tree's foot: what the dots mean, and whether ignored files are hidden. */
export const FileTreeLegend = component<FileTreeLegendProps>(({ props }) => () => (
    <div data-scope={SCOPE} data-part="legend">
        <span data-scope={SCOPE} data-part="dot" data-tone="working" aria-hidden="true" />
        <span>changed</span>
        <span data-scope={SCOPE} data-part="dot" data-tone="live" aria-hidden="true" />
        <span>added</span>
        <span data-spacer="" />
        {props.ignoredHidden ? <span data-mono="">{props.ignoreLabel ?? '.gitignore hidden'}</span> : null}
    </div>
), { name: 'FileTreeLegend' });
