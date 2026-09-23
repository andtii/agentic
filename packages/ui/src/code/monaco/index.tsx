/**
 * The Monaco renderer (#563) — the default `CodeRenderer`. Each surface
 * renders the plain grid first (the server's markup, hydration-safe, and
 * what stays if Monaco never loads), imports the Monaco engine once it is
 * mounted on the client, and swaps the editor in when it reports ready.
 */
import { component, onMounted, signal, type ComponentFactory, type JSXElement } from '@sigx/runtime-core';
import { agCodeAnatomy } from '../anatomy.js';
import { PlainDiff, PlainViewer } from '../plain.js';
import type { CodeDiffProps, CodeRenderer, CodeViewerProps } from '../types.js';

const SCOPE = agCodeAnatomy.scope;

type Engine = typeof import('./engine.js');
let engine: Promise<Engine> | undefined;

/** The engine module, imported once per page (a failed import is retried by the next surface). */
export function loadMonacoEngine(): Promise<Engine> {
    engine ??= import('./engine.js').catch((error: unknown) => {
        engine = undefined;
        throw error;
    });
    return engine;
}

/** A component taking any props — the surfaces forward theirs unchanged. */
type Forwarding = (props: Record<string, unknown>) => JSXElement;

/** Build a surface: plain until the engine's component has mounted and reports ready. */
function surface<P extends object>(name: string, kind: 'viewer' | 'diff', plain: unknown, pick: (e: Engine) => unknown): ComponentFactory<P, void, {}> {
    const Plain = plain as Forwarding;
    return component<P>(({ props }) => {
        const st = signal({ loaded: false, ready: false });
        let Impl: Forwarding | null = null;
        onMounted(() => {
            loadMonacoEngine().then((e) => {
                Impl = pick(e) as Forwarding;
                st.loaded = true;
            }, (error: unknown) => {
                if (__DEV__) console.warn('[@agentic/ui] the Monaco renderer could not load; the plain one stays', error);
            });
        });
        return () => {
            const Engine = st.loaded ? Impl : null;
            const clickable = (props as { onLineSelect?: unknown }).onLineSelect ? '' : undefined;
            return (
                <div data-scope={SCOPE} data-part="root" data-kind={kind} data-engine="monaco" data-ready={st.ready ? '' : undefined} data-clickable={clickable}>
                    <div data-plain="">
                        <Plain {...(props as Record<string, unknown>)} />
                    </div>
                    {Engine ? <Engine {...(props as Record<string, unknown>)} onEngineReady={() => { st.ready = true; }} /> : null}
                </div>
            );
        };
    }, { name }) as unknown as ComponentFactory<P, void, {}>;
}

export const MonacoViewer = surface<CodeViewerProps>('MonacoViewer', 'viewer', PlainViewer, (e) => e.MonacoViewerEngine);
export const MonacoDiff = surface<CodeDiffProps>('MonacoDiff', 'diff', PlainDiff, (e) => e.MonacoDiffEngine);

/** The Monaco renderer as a `CodeRenderer`. */
export const monacoCodeRenderer: CodeRenderer = { id: 'monaco', Viewer: MonacoViewer, Diff: MonacoDiff };
