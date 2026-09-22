/**
 * "Browse…" on the folders card (#482): a folder picker over the whole
 * machine — `Machine.browseMachine` lists the machine's roots (drives, `/`,
 * the home folder) and then any folder's subfolders, folders only, no git
 * badges — in the workdir picker's own anatomy (`ag-workdir-picker`), so it
 * looks like the folder picker everywhere else. Controlled like that one:
 * the host browses, the dialog asks for moves (`navigate`) and hands back
 * the folder on "Allow this folder" (`select`).
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Dialog } from '@sigx/zero';
import { FS_LIST_MAX_ENTRIES, type HostOs, type MachineListing } from '@agentic/core';
import { Button, Icon, TableSkeleton, middleTruncate } from '@agentic/ui';

const SCOPE = 'ag-workdir-picker';

export interface BrowseCrumb {
    readonly label: string;
    readonly path: string;
}

/** `C:\Users\andy` → `C:\` › `Users` › `andy`; `/home/me` → `/` › `home` › `me`. */
export function browseCrumbs(path: string, os: HostOs): BrowseCrumb[] {
    if (os === 'windows') {
        const m = /^([A-Za-z]:)[\\/]?(.*)$/.exec(path);
        if (!m) return [{ label: path, path }];
        const drive = `${m[1]}\\`;
        const out: BrowseCrumb[] = [{ label: drive, path: drive }];
        let at = m[1]!;
        for (const seg of m[2]!.split(/[\\/]/).filter(Boolean)) {
            at = `${at}\\${seg}`;
            out.push({ label: seg, path: at });
        }
        return out;
    }
    const out: BrowseCrumb[] = [{ label: '/', path: '/' }];
    let at = '';
    for (const seg of path.split('/').filter(Boolean)) {
        at = `${at}/${seg}`;
        out.push({ label: seg, path: at });
    }
    return out;
}

export type BrowseDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'machineName', string, true>
    & Define.Prop<'os', HostOs, true>
    /** The folder on screen; `null` is the machine's roots. */
    & Define.Prop<'path', string | null, true>
    /** The roots listing (`browseMachine()` without a path), once it landed. */
    & Define.Prop<'roots', MachineListing | null>
    /** The listing of `path`. */
    & Define.Prop<'listing', MachineListing | null>
    & Define.Prop<'loading', boolean>
    & Define.Prop<'error', string | null>
    & Define.Event<'navigate', string | null>
    & Define.Event<'select', string>
    & Define.Event<'cancel'>;

export const BrowseDialog = component<BrowseDialogProps>(({ props, emit }) => {
    // A close after `select` or Cancel is finished business; any other close (Escape, backdrop) is a cancel.
    let finished = false;
    const close = (): void => {
        if (props.model) props.model.value = false;
    };
    const cancel = (): void => {
        finished = true;
        emit('cancel');
        close();
    };
    const onOpenChange = (open: boolean): void => {
        if (open) finished = false;
        else if (!finished) {
            finished = true;
            emit('cancel');
        }
    };
    /** The listing, when it is the one for the folder on screen. */
    const current = (): MachineListing | null => (props.path !== null && props.listing && props.listing.path === props.path ? props.listing : null);
    const select = (): void => {
        const l = current();
        if (!l || props.loading || props.error) return;
        finished = true;
        emit('select', l.path);
        close();
    };

    const notice = (kind: string, text: string, action?: JSXElement): JSXElement => (
        <p data-scope={SCOPE} data-part="notice" data-notice={kind} role={kind === 'error' ? 'alert' : 'status'}>
            <span>{text}</span>
            {action ?? null}
        </p>
    );

    const bar = (): JSXElement => {
        const path = props.path;
        const crumbs = path === null ? [] : browseCrumbs(path, props.os);
        return (
            <div data-scope={SCOPE} data-part="bar">
                <nav data-scope={SCOPE} data-part="crumbs" aria-label="Folder path">
                    <ol>
                        <li>
                            <button type="button" data-scope={SCOPE} data-part="crumb" aria-current={path === null ? 'location' : undefined} onClick={() => emit('navigate', null)}>{props.machineName}</button>
                        </li>
                        {crumbs.map((c, i) => (
                            <li key={c.path}>
                                <Icon name="chevron-right" size={14} />
                                <button type="button" data-scope={SCOPE} data-part="crumb" title={c.path} aria-current={i === crumbs.length - 1 ? 'location' : undefined} onClick={() => emit('navigate', c.path)}>{c.label}</button>
                            </li>
                        ))}
                    </ol>
                </nav>
            </div>
        );
    };

    const list = (entries: readonly { readonly name: string; readonly path: string }[], label: string): JSXElement => (
        <ul data-scope={SCOPE} data-part="list" role="listbox" aria-label={label} aria-busy={props.loading ? 'true' : undefined} data-stale={props.loading ? '' : undefined}>
            {entries.map((entry) => (
                <li key={entry.path} data-scope={SCOPE} data-part="item" role="option" aria-selected="false" title={entry.path} onClick={() => { if (!props.loading) emit('navigate', entry.path); }}>
                    <Icon name="folder" size={15} />
                    <span data-scope={SCOPE} data-part="name">{entry.name}</span>
                </li>
            ))}
        </ul>
    );

    const body = (): JSXElement => {
        if (props.error) return notice('error', props.error, <Button intent="default" onClick={() => emit('navigate', props.path)}>Try again</Button>);
        if (props.path === null) {
            const roots = props.roots;
            if (!roots) return props.loading ? <TableSkeleton rows={3} cols="1fr" label="Loading the machine's roots" /> : null;
            return (
                <section data-scope={SCOPE} data-part="section" aria-label="Roots">
                    <h3 data-scope={SCOPE} data-part="heading">Roots</h3>
                    <ul data-scope={SCOPE} data-part="shortcuts">
                        {roots.entries.map((r) => (
                            <li key={r.path}>
                                <button type="button" data-scope={SCOPE} data-part="shortcut" title={r.path} onClick={() => emit('navigate', r.path)}>
                                    <Icon name="folder" size={14} />
                                    <span>{r.name === r.path ? middleTruncate(r.path) : `${r.name} — ${middleTruncate(r.path)}`}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            );
        }
        const listing = current();
        if (!listing) return props.loading ? <TableSkeleton rows={4} cols="1fr" label="Loading folders" /> : null;
        return (
            <>
                {listing.entries.length ? list(listing.entries, `Folders in ${listing.path}`) : props.loading ? <TableSkeleton rows={4} cols="1fr" label="Loading folders" /> : notice('empty', 'No subfolders — allow this folder, or go up.')}
                {listing.truncated && !props.loading ? notice('truncated', `Showing the first ${FS_LIST_MAX_ENTRIES} folders`) : null}
            </>
        );
    };

    return (): JSXElement => {
        const canSelect = !!current() && !props.loading && !props.error;
        return (
            <Dialog.Root model={props.model} modal onOpenChange={onOpenChange}>
                <Dialog.Popup>
                    <Dialog.Title>Choose a folder on {props.machineName}</Dialog.Title>
                    <Dialog.Description>Anywhere on the machine except the daemon's own folders. Agents in this workspace will be able to work inside it.</Dialog.Description>
                    <div data-scope={SCOPE} data-part="root" data-browse-machine data-mod-loading={props.loading ? '' : undefined}>
                        {bar()}
                        {body()}
                    </div>
                    <Dialog.Footer>
                        <Button intent="default" onClick={cancel}>Cancel</Button>
                        <Button intent="primary" icon="check" disabled={!canSelect} onClick={select}>Allow this folder</Button>
                    </Dialog.Footer>
                </Dialog.Popup>
            </Dialog.Root>
        );
    };
});
