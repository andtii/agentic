/**
 * Choosing the code renderer (#563). `useCodeRenderer` resolves the nearest
 * provided renderer — a subtree's `CodeRendererProvider`, the app's
 * `app.defineProvide(useCodeRenderer, () => renderer)` — and falls back to
 * Monaco. `CodeViewer` and `CodeDiff` are what pages render: they forward
 * their props to whichever renderer is in effect.
 */
import { component, defineInjectable, defineProvide, type Define } from '@sigx/runtime-core';
import { monacoCodeRenderer } from './monaco/index.js';
import type { CodeDiffProps, CodeRenderer, CodeViewerProps } from './types.js';

/** The renderer in effect: provided, else Monaco (which draws the plain grid until it has loaded). */
export const useCodeRenderer = defineInjectable<CodeRenderer>(() => monacoCodeRenderer, { name: 'CodeRenderer' });

export type CodeRendererProviderProps =
    & Define.Prop<'renderer', CodeRenderer, true>
    & Define.Slot<'default'>;

/** Use `renderer` for every `CodeViewer` / `CodeDiff` below. */
export const CodeRendererProvider = component<CodeRendererProviderProps>(({ props, slots }) => {
    defineProvide(useCodeRenderer, () => props.renderer);
    return () => <>{slots.default?.()}</>;
}, { name: 'CodeRendererProvider' });

/** A read-only file, drawn by the renderer in effect. */
export const CodeViewer = component<CodeViewerProps>(({ props }) => {
    const renderer = useCodeRenderer();
    const Viewer = renderer.Viewer;
    return () => <Viewer {...props} />;
}, { name: 'CodeViewer' });

/** A diff of two texts, drawn by the renderer in effect. */
export const CodeDiff = component<CodeDiffProps>(({ props }) => {
    const renderer = useCodeRenderer();
    const Diff = renderer.Diff;
    return () => <Diff {...props} />;
}, { name: 'CodeDiff' });
