/**
 * `/sessions/:id/files?path=` (#564, `Files` board): the session's folder as
 * a tree — changed files dotted, `.gitignore` respected — and the chosen file
 * read-only through the code renderer in effect, with a stripe on every line
 * that differs from HEAD. Everything comes through the session's
 * `WorkspaceSource`; a folder loads when it is opened. Below 768 px the tree
 * and the viewer are two screens.
 */
import { component, signal, watch, type JSXElement } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import type { FileChangeStatus, FsError, FsTreeEntry } from '@agentic/core';
import { Button, CodeViewer, EmptyState, FileHeader, FileTree, FileTreeLegend, GoToFile, Icon, changedLines, fileSizeText, splitPath, type LineMark } from '@agentic/ui';
import { Page } from '../components/Page';
import { defineTopbar, routeId } from '../components/topbar';
import { dataMode } from '../data-mode';
import { agentNamed, loadSession } from '../mock/workspace';
import { LinkButton } from './ops/LinkButton';
import { SessionFilesBar, envLineOf } from './session/bar';
import { changesHref, displayRoot, filesHref, queryOf, relativeToRoot, useSessionChanges, type SessionFiles } from './session/files';
import { SessionFrame, type SessionFrameContext } from './session/frame';
import { sessionHead } from './session/LiveSession';
import { sessionTrail } from './session/trail';

defineTopbar('session-files', (route) => {
    const id = routeId(route);
    const head = dataMode() === 'live' ? (sessionHead.value?.id === id ? sessionHead.value : undefined) : undefined;
    const v = head?.view ?? (dataMode() === 'live' ? undefined : loadSession(id));
    const agentName = head?.agentName ?? (v ? agentNamed(v.agentId).name : undefined);
    return {
        ...(v ? { crumb: 'Files', trail: sessionTrail(id, v, agentName, 'Files') } : {}),
        actions: () => (v?.chatId ? <LinkButton to={`/chats/${v.chatId}`} icon="chats">Open chat</LinkButton> : null)
    };
});

export const SessionFilesPage = component(() => {
    const route = useRoute();
    return () => <SessionFrame id={String(route.params.id)} title="Files" page="session-files" render={(ctx) => <FilesView ctx={ctx} />} />;
});

interface FileText {
    loading: boolean;
    text?: string;
    size?: number;
    lines?: number;
    binary?: boolean;
    marks?: readonly LineMark[];
    error?: FsError;
}

const copyPath = (path: string): void => { void navigator.clipboard?.writeText(path).catch(() => undefined); };

/** `82 lines · 2.1 KB`. */
export const fileFacts = (lines: number | undefined, size: number | undefined): string => [lines !== undefined ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : '', size !== undefined ? fileSizeText(size) : ''].filter(Boolean).join(' · ');

export const FilesView = component<{ ctx: SessionFrameContext }>(({ props }) => {
    const route = useRoute();
    const router = useRouter();
    const st = signal({ version: 0, known: [] as string[], ignoredHidden: false, rootError: null as FsError | null });
    const files = (): SessionFiles => props.ctx.files;
    // A tool call's link names the file absolute: read relative to the folder, as the source answers; a path
    // outside the folder is none of this view's.
    const path = (): string | undefined => { const q = queryOf(route.query.path); return q === undefined ? undefined : relativeToRoot(files().root, q) || undefined; };
    const uncommitted = useSessionChanges(() => files(), () => (files().vcs === false ? null : 'uncommitted'), () => st.version);
    const changeOf = (p: string): FileChangeStatus | undefined => uncommitted.set?.files.find((f) => f.path === p)?.status;

    const text = signal<FileText>({ loading: false });
    let ticket = 0;
    watch(
        () => `${path() ?? ''}|${st.version}|${files().online}|${changeOf(path() ?? '') ?? ''}`,
        () => {
            const p = path();
            const f = files();
            const mine = ++ticket;
            text.text = undefined;
            text.error = undefined;
            text.binary = undefined;
            text.marks = undefined;
            text.size = undefined;
            text.lines = undefined;
            // A superseded read no longer clears `loading`, so this run always sets it.
            text.loading = false;
            if (!p || !f.source || !f.online) return;
            const change = changeOf(p);
            text.loading = true;
            void Promise.all([f.source.read(p, 'working'), change === 'modified' || change === 'renamed' ? f.source.read(p, 'head') : Promise.resolve(null)]).then(([working, head]) => {
                if (mine !== ticket) return;
                if (working.error) {
                    text.error = working.error;
                    return;
                }
                const r = working.result;
                text.size = r.size;
                if (r.binary) {
                    text.binary = true;
                    return;
                }
                text.text = r.text ?? '';
                text.lines = r.lines;
                if (change === 'added' || change === 'untracked') text.marks = Array.from({ length: r.lines ?? 0 }, (_, i) => ({ line: i + 1, tone: 'live' as const }));
                else if (head?.result?.text !== undefined) text.marks = changedLines(head.result.text, text.text).map((line) => ({ line, tone: 'working' as const }));
            }, (e: unknown) => {
                if (mine === ticket) text.error = { code: 'internal', message: e instanceof Error ? e.message : String(e) };
            }).finally(() => {
                if (mine === ticket) text.loading = false;
            });
        },
        { immediate: true }
    );

    /** One folder for the tree; the root's answer also says whether ignored files are hidden. */
    const load = async (dir: string): Promise<readonly FsTreeEntry[]> => {
        const source = files().source;
        if (!source) throw new Error('This session has no folder.');
        if (!files().online) throw new Error(`${files().machineName} is offline.`);
        const answer = await source.tree(dir);
        if (answer.error) {
            if (dir === '') st.rootError = answer.error;
            throw new Error(answer.error.code === 'not-found' && dir === '' ? `Folder no longer on ${files().machineName}` : answer.error.message);
        }
        if (dir === '') {
            st.ignoredHidden = answer.result.ignoredHidden;
            st.rootError = null;
        }
        const add = answer.result.entries.filter((e) => e.type !== 'dir').map((e) => e.path).filter((p) => !st.known.includes(p));
        if (add.length) st.known = [...st.known, ...add];
        return answer.result.entries;
    };

    const open = (p: string | undefined): void => { void router.push(filesHref(props.ctx.v.id, p)); };

    const viewer = (p: string | undefined): JSXElement => {
        const f = files();
        if (!p) return <p data-files-note>Choose a file to read it.</p>;
        if (!f.online) return <p data-files-note>Files come from {f.machineName}; this one shows again when the machine reconnects.</p>;
        if (text.error?.code === 'too-large') return <p data-files-note>This file is too large to show here ({text.error.message}).</p>;
        if (text.error) return <p data-files-note role="alert">{text.error.message}</p>;
        if (text.binary) return <p data-files-note>Binary file · {fileSizeText(text.size ?? 0)} — not shown.</p>;
        if (text.text === undefined) return <p data-files-note aria-busy="true">Loading {splitPath(p).name}…</p>;
        return (
            <div data-files-surface>
                <CodeViewer text={text.text} path={p} {...(text.marks?.length ? { lineMarks: text.marks, revealLine: text.marks[0]!.line } : {})} />
            </div>
        );
    };

    return () => {
        const { v, agent } = props.ctx;
        const f = files();
        const p = path();
        const change = p ? changeOf(p) : undefined;
        const unc = uncommitted.set;
        const offline = !f.online;
        if (!f.files) {
            return (
                <Page title={`Files · ${v.ref}`} page="session-files" hideTitle flush>
                    <SessionFilesBar id={v.id} current="files" files={f} agent={{ name: agent.name, hue: agent.hue }} env={envLineOf(v.environment)} />
                    <div data-files-empty>
                        <EmptyState variant="generic" title="This session has no folder" caption={`${agent.name} runs on the platform, with no filesystem to show.`} />
                    </div>
                </Page>
            );
        }
        const paths = [...new Set([...st.known, ...(unc?.files.filter((x) => x.status !== 'deleted').map((x) => x.path) ?? [])])];
        const vcs = f.vcs !== false && uncommitted.error?.code !== 'not-a-repo';
        return (
            <Page title={`Files · ${v.ref}`} page="session-files" hideTitle flush>
                <SessionFilesBar id={v.id} current="files" files={vcs ? f : { ...f, vcs: false }} agent={{ name: agent.name, hue: agent.hue }} env={envLineOf(v.environment)} {...(unc ? { changes: unc } : {})}>
                    <Button intent="icon" icon="history" label={offline ? 'Refresh (the machine is offline)' : 'Refresh from the machine'} disabled={offline} onClick={() => { st.version++; }} />
                </SessionFilesBar>
                {offline ? <p data-files-banner role="status"><Icon name="wifi" size={14} /> Machine disconnected · files show again when {f.machineName} reconnects</p> : null}
                {st.rootError?.code === 'not-found' ? <p data-files-banner data-tone="failed" role="alert">Folder no longer on {f.machineName}</p> : null}
                <div data-files-body data-has-file={p ? '' : undefined}>
                    <aside data-files-tree aria-label="Folder">
                        <GoToFile paths={paths} onPick={(x) => open(x)} hotkey id="session-files-find" />
                        <p data-files-root title={f.root}>{`‎${displayRoot(f.root)}‎`}</p>
                        <div data-files-tree-scroll>
                            <FileTree load={load} {...(p ? { selected: p } : {})} onSelect={(entry) => open(entry.path)} version={st.version} label={`Files in ${displayRoot(f.root)}`} />
                        </div>
                        <FileTreeLegend ignoredHidden={st.ignoredHidden} />
                    </aside>
                    <section data-files-main aria-label={p ? p : 'File'}>
                        {p ? <a data-files-back href={filesHref(v.id)} onClick={(e: MouseEvent) => { e.preventDefault(); open(undefined); }}><Icon name="back" size={16} />All files</a> : null}
                        {p ? (
                            <FileHeader path={p} breadcrumbs {...(change ? { status: change } : {})} facts={fileFacts(text.lines, text.size)}>
                                {f.fileActions?.(p) ?? null}
                                {change && vcs ? <LinkButton to={changesHref(v.id, { file: p })}>Open diff</LinkButton> : null}
                                {f.mention ? <Button icon="chats" onClick={() => f.mention?.(p)}>Mention in chat</Button> : null}
                                <Button intent="icon" icon="copy" label="Copy path" onClick={() => copyPath(p)} />
                            </FileHeader>
                        ) : null}
                        {viewer(p)}
                    </section>
                </div>
            </Page>
        );
    };
});
