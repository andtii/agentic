/**
 * `/sessions/:id/changes?file=&scope=uncommitted|branch&view=unified|split`
 * (#564, `Changes` board): what the agent did to the session's folder. Left,
 * the changed files (uncommitted, or the branch against its base) and the
 * commits on the branch; right, the chosen file's diff through the code
 * renderer in effect (Monaco by default, the plain grid before it loads).
 * Everything comes through the session's `WorkspaceSource`; the query is the
 * state, so every view is a link. Below 768 px the list and the diff are two
 * screens: choosing a file opens its diff full-screen with a back link.
 */
import { component, signal, watch, type JSXElement } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import type { ChangedFile, ChangeScope, FsError, FsReadResult, FsReadRev, WorkspaceAnswer } from '@agentic/core';
import { Button, ChangeList, ChangesPanel, CodeDiff, CommitList, EmptyState, FileHeader, Icon, LineComposer, Segmented, fileSizeText, hunkAt, splitPath, type DiffMode, type LineRef } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar, routeId } from '../components/topbar';
import { dataMode } from '../data-mode';
import { agentNamed, loadSession } from '../mock/workspace';
import { LinkButton } from './ops/LinkButton';
import { SessionFilesBar, envLineOf } from './session/bar';
import { changesHref, displayRoot, filesHref, queryOf, useSessionChanges, type SessionFiles } from './session/files';
import { SessionFrame, type SessionFrameContext } from './session/frame';
import { sessionHead } from './session/LiveSession';
import { sessionTrail } from './session/trail';

defineTopbar('session-changes', (route) => {
    const id = routeId(route);
    const head = dataMode() === 'live' ? (sessionHead.value?.id === id ? sessionHead.value : undefined) : undefined;
    const v = head?.view ?? (dataMode() === 'live' ? undefined : loadSession(id));
    const agentName = head?.agentName ?? (v ? agentNamed(v.agentId).name : undefined);
    return {
        ...(v ? { crumb: 'Changes', trail: sessionTrail(id, v, agentName, 'Changes') } : {}),
        actions: () => (v?.chatId ? <LinkButton to={`/chats/${v.chatId}`} icon="chats">Open chat</LinkButton> : null)
    };
});

export const SessionChanges = component(() => {
    const route = useRoute();
    return () => <SessionFrame id={String(route.params.id)} title="Changes" page="session-changes" render={(ctx) => <ChangesView ctx={ctx} />} />;
});

/** The texts a diff needs, per scope: uncommitted is HEAD → working tree, branch is base → HEAD. */
const REVS: Record<ChangeScope, readonly [FsReadRev, FsReadRev]> = { uncommitted: ['head', 'working'], branch: ['base', 'head'] };

interface DiffTexts {
    loading: boolean;
    original?: string;
    modified?: string;
    binary?: { size: number };
    error?: FsError;
}

/** Load both sides of `file`'s diff; a side the file does not have (added, deleted) is empty. */
function useDiffTexts(files: () => SessionFiles, key: () => { scope: ChangeScope; file: ChangedFile } | null, version: () => number): DiffTexts {
    const st = signal<DiffTexts>({ loading: false });
    let ticket = 0;
    watch(
        () => {
            const k = key();
            return k ? `${k.scope}|${k.file.path}|${k.file.status}|${version()}|${files().online}` : '';
        },
        () => {
            const k = key();
            const f = files();
            const mine = ++ticket;
            st.original = undefined;
            st.modified = undefined;
            st.binary = undefined;
            st.error = undefined;
            if (!k || !f.source) return;
            if (!f.online) return;
            const [from, to] = REVS[k.scope];
            const side = async (rev: FsReadRev, path: string, absent: boolean): Promise<WorkspaceAnswer<FsReadResult>> => (absent ? { result: { kind: 'read', path, rev, size: 0, text: '' } } : f.source!.read(path, rev));
            st.loading = true;
            void Promise.all([
                side(from, k.file.oldPath ?? k.file.path, k.file.status === 'added' || k.file.status === 'untracked'),
                side(to, k.file.path, k.file.status === 'deleted')
            ]).then(([a, b]) => {
                if (mine !== ticket) return;
                if (a.error || b.error) {
                    st.error = a.error ?? b.error;
                    return;
                }
                const [ra, rb] = [a.result!, b.result!];
                if (ra.binary || rb.binary) st.binary = { size: rb.binary ? rb.size : ra.size };
                else {
                    st.original = ra.text ?? '';
                    st.modified = rb.text ?? '';
                }
            }, (e: unknown) => {
                if (mine === ticket) st.error = { code: 'internal', message: e instanceof Error ? e.message : String(e) };
            }).finally(() => {
                if (mine === ticket) st.loading = false;
            });
        },
        { immediate: true }
    );
    return st;
}

const SCOPES = [{ value: 'uncommitted', label: 'Uncommitted' }, { value: 'branch', label: 'Branch' }] as const;
const VIEWS = [{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }] as const;

const copyPath = (path: string): void => { void navigator.clipboard?.writeText(path).catch(() => undefined); };

export const ChangesView = component<{ ctx: SessionFrameContext }>(({ props }) => {
    const route = useRoute();
    const router = useRouter();
    const st = signal({ version: 0, selected: null as LineRef | null, sending: false, sent: '' });
    const files = (): SessionFiles => props.ctx.files;
    const q = () => ({
        file: queryOf(route.query.file),
        scope: queryOf(route.query.scope) as ChangeScope | undefined,
        view: (queryOf(route.query.view) === 'split' ? 'split' : 'unified') as DiffMode
    });
    const uncommitted = useSessionChanges(() => files(), () => 'uncommitted', () => st.version);
    /** The scope shown: the query's, else Branch when nothing is uncommitted (the handoff's "No changes" row). */
    const scope = (): ChangeScope => q().scope ?? (uncommitted.set && uncommitted.set.files.length === 0 ? 'branch' : 'uncommitted');
    const branch = useSessionChanges(() => files(), () => (scope() === 'branch' ? 'branch' : null), () => st.version);
    const current = () => (scope() === 'branch' ? branch : uncommitted);
    const fileOf = (): ChangedFile | undefined => {
        const set = current().set;
        if (!set) return undefined;
        const want = q().file;
        return (want ? set.files.find((f) => f.path === want) : undefined) ?? (want ? undefined : set.files[0]);
    };
    const texts = useDiffTexts(() => files(), () => { const file = fileOf(); return file ? { scope: scope(), file } : null; }, () => st.version);
    // A new file or scope closes the question box.
    watch(() => `${scope()}|${fileOf()?.path ?? ''}|${q().view}`, () => { st.selected = null; });
    // The segmented controls' models, following the query (the query is the state; a click navigates).
    const seg = signal({ view: q().view as string, scope: scope() as string });
    watch(() => `${q().view}|${scope()}`, () => { seg.view = q().view; seg.scope = scope(); });

    const go = (next: { file?: string; scope?: ChangeScope; view?: DiffMode }): void => {
        const cur = q();
        const href = changesHref(props.ctx.v.id, { file: 'file' in next ? next.file : cur.file, scope: next.scope ?? cur.scope, view: next.view ?? cur.view });
        // Opening a file is a step back can undo (the phone's full-screen diff); a layout or scope switch is not.
        void ('file' in next && next.scope === undefined ? router.push(href) : router.replace(href));
    };

    const ask = async (text: string): Promise<void> => {
        const f = files();
        const file = fileOf();
        const ref = st.selected;
        if (!f.ask || !file || !ref || texts.original === undefined || texts.modified === undefined) return;
        st.sending = true;
        try {
            await f.ask({ path: file.path, ref, text, hunk: hunkAt(texts.original, texts.modified, ref), scope: scope() });
            st.sent = `Asked ${props.ctx.agent.name} about ${splitPath(file.path).name}:${ref.line}`;
            st.selected = null;
        } finally {
            st.sending = false;
        }
    };

    const diffBody = (file: ChangedFile | undefined): JSXElement => {
        const f = files();
        if (!file) return <p data-files-note>{current().loading ? 'Loading changes…' : 'Choose a file to see its diff.'}</p>;
        if (!f.online) return <p data-files-note>The diff comes from {f.machineName}; it shows again when the machine reconnects.</p>;
        if (texts.error?.code === 'too-large') {
            return (
                <div data-files-state="too-large">
                    <EmptyState variant="generic" title="This diff is too large to show here" caption={texts.error.message} slots={{ actions: () => <LinkButton to={filesHref(f.sessionId, file.path)} icon="file">Open in Files</LinkButton> }} />
                </div>
            );
        }
        if (texts.error) return <p data-files-note role="alert">{texts.error.message}</p>;
        if (texts.binary) return <p data-files-note>Binary file · {fileSizeText(texts.binary.size)} — nothing to diff.</p>;
        if (texts.original === undefined || texts.modified === undefined) return <p data-files-note aria-busy="true">Loading diff…</p>;
        const agent = props.ctx.agent;
        const selected = st.selected;
        return (
            <div data-files-surface>
                <CodeDiff
                    original={texts.original}
                    modified={texts.modified}
                    path={file.path}
                    mode={q().view}
                    {...(selected ? { selected } : {})}
                    {...(f.ask ? { onLineSelect: (ref: LineRef) => { st.selected = ref; st.sent = ''; } } : {})}
                    {...(f.ask && selected ? {
                        lineWidget: () => (
                            <LineComposer
                                agent={{ name: agent.name, hue: agent.hue }}
                                line={selected.line}
                                fileRef={`${splitPath(file.path).name}:${selected.line}`}
                                {...(f.chat ? { note: `Posts to “${f.chat.title}” with the file, line and hunk attached` } : {})}
                                sending={st.sending}
                                onSend={(text) => { void ask(text); }}
                                onCancel={() => { st.selected = null; }}
                            />
                        )
                    } : {})}
                />
            </div>
        );
    };

    return () => {
        const { v, agent } = props.ctx;
        const f = files();
        const cur = q();
        const sc = scope();
        const state = current();
        const unc = uncommitted.set;
        const file = fileOf();
        const offline = !f.online;
        const env = envLineOf(v.environment);
        const noVcs = f.vcs === false || uncommitted.error?.code === 'not-a-repo';
        const bar = (controls: boolean): JSXElement => (
            <SessionFilesBar id={v.id} current="changes" files={noVcs ? { ...f, vcs: false } : f} agent={{ name: agent.name, hue: agent.hue }} env={env} {...(unc ? { changes: unc } : {})}>
                {controls ? (
                    <>
                        <Segmented class="ag-diff-layout" label="Diff layout" options={VIEWS} model={() => seg.view} onValueChange={(view: string) => go({ view: view as DiffMode })} />
                        <Segmented label="Changes to show" options={SCOPES} model={() => seg.scope} onValueChange={(s: string) => go({ scope: s as ChangeScope, file: undefined })} />
                        <Button intent="icon" icon="history" label={offline ? 'Refresh (the machine is offline)' : 'Refresh from the machine'} disabled={offline} onClick={() => { st.version++; }} />
                    </>
                ) : null}
            </SessionFilesBar>
        );

        // No folder (an API agent) or no VCS: the view has nothing to show.
        if (!f.files || noVcs) {
            const noFolder = !f.files;
            return (
                <Page title={`Changes · ${v.ref}`} page="session-changes" hideTitle flush>
                    {bar(false)}
                    <div data-files-empty>
                        <EmptyState
                            variant="generic"
                            title={noFolder ? 'This session has no folder' : 'Not a git repository'}
                            caption={noFolder ? `${agent.name} runs on the platform, with no filesystem to show.` : `${displayRoot(f.root)} is not under version control; its files are still in Files.`}
                            {...(noFolder ? {} : { slots: { actions: () => <LinkButton to={filesHref(v.id)} icon="folder">Open Files</LinkButton> } })}
                        />
                    </div>
                </Page>
            );
        }

        const folderGone = state.error?.code === 'not-found';
        const note = `Read-only. Files stay on ${f.machineName}; the daemon sends what you open.`;
        const autoBranch = !cur.scope && sc === 'branch';
        const author = (c: { author: string }) => (c.author.toLowerCase() === agent.name.toLowerCase() ? { name: agent.name, hue: agent.hue } : { name: c.author, person: true });
        return (
            <Page title={`Changes · ${v.ref}`} page="session-changes" hideTitle flush>
                {bar(true)}
                {offline ? (
                    <p data-files-banner role="status">
                        <Icon name="wifi" size={14} /> Machine disconnected
                        {state.snapshotAt ? ` · showing what ${f.machineName} last reported at ${(f.time ?? String)(state.snapshotAt)}` : ` · nothing fetched from ${f.machineName} yet`}
                    </p>
                ) : null}
                {folderGone ? <p data-files-banner data-tone="failed" role="alert">Folder no longer on {f.machineName}</p> : null}
                {state.error && !folderGone ? <p data-files-banner data-tone="failed" role="alert">{state.error.message}</p> : null}
                <div data-files-body data-has-file={cur.file ? '' : undefined}>
                    <ChangesPanel note={note}>
                        {autoBranch ? <p data-files-note data-changes-empty>No uncommitted changes</p> : null}
                        {state.set ? (
                            <ChangeList
                                files={state.set.files}
                                label={sc === 'branch' ? `Branch${state.set.base ? ` vs ${state.set.base}` : ''}` : 'Uncommitted'}
                                {...(file ? { current: file.path } : {})}
                                href={(x) => changesHref(v.id, { file: x.path, scope: cur.scope, view: cur.view })}
                                onOpen={(x, e) => { e.preventDefault(); go({ file: x.path }); }}
                                empty={sc === 'branch' ? 'Nothing on this branch yet' : 'No uncommitted changes'}
                            />
                        ) : <p data-files-note aria-busy={state.loading ? 'true' : undefined}>{state.loading ? 'Loading changes…' : state.offlineEmpty ? 'No snapshot yet.' : ''}</p>}
                        {state.set && (state.set.commits.length || state.set.base) ? (
                            <CommitList commits={state.set.commits} {...(state.set.base ? { base: state.set.base } : {})} author={author} {...(f.time ? { formatTime: f.time } : {})} empty="No commits ahead of the base" />
                        ) : null}
                    </ChangesPanel>
                    <section data-files-main aria-label={file ? `Diff of ${file.path}` : 'Diff'}>
                        {cur.file ? <a data-files-back href={changesHref(v.id, { scope: cur.scope, view: cur.view })} onClick={(e: MouseEvent) => { e.preventDefault(); go({ file: undefined }); }}><Icon name="back" size={16} />All changes</a> : null}
                        {file ? (
                            <FileHeader path={file.path} status={file.status} {...(file.added !== undefined ? { added: file.added } : {})} {...(file.removed !== undefined ? { removed: file.removed } : {})}>
                                {f.fileActions?.(file.path) ?? null}
                                <Button intent="icon" icon="copy" label="Copy path" onClick={() => copyPath(file.path)} />
                            </FileHeader>
                        ) : null}
                        {st.sent ? <p data-files-note role="status" data-files-sent>{st.sent}</p> : null}
                        {diffBody(file)}
                    </section>
                </div>
            </Page>
        );
    };
});
