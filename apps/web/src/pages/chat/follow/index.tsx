/**
 * The Follow panel (#1060, CHT-09, AGT-09; `docs/design/chat-modes/HANDOFF.md` → "Team", "Follow panel"):
 * one agent's live work — its task and environment with the step count, its last steps, the tail of its
 * live output with a cursor, `Message X` and `Stop`. It opens from a crew chip or a work card's `Follow`
 * (`ChatViewModel.onFollow`) and takes the right column in place of the context panel; closing it brings
 * the context panel back. When the agent finishes, the panel shows the result and stays open. Following
 * never writes to the thread.
 *
 * Below 1280 px the right column is gone (the context panel sits behind the topbar's tasks button), so
 * the panel opens in a `Drawer` at the end edge; on a phone (below 768 px) as a bottom sheet — zero's
 * Drawer in the pinned release has no bottom placement (signalxjs/zero#291 adds it), so the end drawer is
 * restyled inline until the catalog moves.
 */
import { component, onMounted, onUnmounted, signal, type Define, type JSXElement } from 'sigx';
import { Drawer } from '@sigx/zero';
import { AiFollow } from '@agentic/ui';
import type { SessionFeed } from '../live';
import type { ChatViewModel } from '../views/types';
import { followView } from './model';

export interface FollowModel {
    /** The followed agent. */
    readonly agentId: string;
    /** Its session feed, when it has one (live). */
    readonly feed?: SessionFeed;
    /** The chat's view model: members, lookup, live work. */
    readonly view: ChatViewModel;
    /** Close the panel: the context panel comes back. */
    readonly onClose: () => void;
    /** `Message X`: put `@X ` into the composer. */
    readonly onMessage: (agentId: string) => void;
}

export type FollowPanelProps = Define.Prop<'follow', FollowModel, true>;

/** Where the right column leaves the chat grid (`--below-xl`), and where a phone starts (`--below-md`). */
export const FOLLOW_DRAWER_BELOW = 1280;
export const FOLLOW_SHEET_BELOW = 768;

export type FollowPlacement = 'column' | 'drawer' | 'sheet';

export function followPlacement(width: number | undefined): FollowPlacement {
    if (width === undefined || width >= FOLLOW_DRAWER_BELOW) return 'column';
    return width < FOLLOW_SHEET_BELOW ? 'sheet' : 'drawer';
}

/** The bottom sheet, until zero's Drawer takes `placement="bottom"`: full width, the lower part of the screen. */
const SHEET_STYLE = 'inset-block-start: auto; inset-inline: 0; inline-size: 100%; max-inline-size: 100%; block-size: auto; max-block-size: 75dvh; overflow-y: auto;';

type FollowDrawerProps =
    & Define.Prop<'placement', 'drawer' | 'sheet', true>
    & Define.Prop<'label', string, true>
    & Define.Prop<'agentId', string, true>
    & Define.Prop<'onClose', () => void, true>
    & Define.Prop<'content', () => JSXElement, true>;

/**
 * The panel in a drawer: it opens once mounted (a drawer mounted open does not show itself), and closing
 * it — Escape, the backdrop, the panel's own Close — stops following.
 */
const FollowDrawer = component<FollowDrawerProps>(({ props }) => {
    const st = signal({ open: false });
    onMounted(() => { st.open = true; });
    return () => (
        <Drawer.Root model={() => st.open} placement="end" label={props.label} onOpenChange={(open: boolean) => { if (!open) props.onClose(); }}>
            <Drawer.Panel {...(props.placement === 'sheet' ? { style: SHEET_STYLE } : {})}>
                <div data-follow-drawer={props.placement} data-chat-follow={props.agentId}>{props.content()}</div>
            </Drawer.Panel>
        </Drawer.Root>
    );
}, { name: 'ChatFollowDrawer' });

export const FollowPanel = component<FollowPanelProps>(({ props }) => {
    const st = signal({ width: undefined as number | undefined });
    const sync = (): void => { st.width = window.innerWidth; };
    onMounted(() => {
        if (typeof window === 'undefined') return;
        sync();
        window.addEventListener('resize', sync);
    });
    // Registered at setup: sigx records lifecycle hooks only there (#1109).
    onUnmounted(() => {
        if (typeof window !== 'undefined') window.removeEventListener('resize', sync);
    });
    return () => {
        const f = props.follow;
        const v = followView(f);
        const panel = (
            <AiFollow
                agent={{ name: v.name, ...(v.hue !== undefined ? { hue: v.hue } : {}) }}
                state={v.state}
                task={v.task}
                env={v.env}
                steps={v.steps}
                output={v.output}
                result={v.result}
                now={Date.now()}
                fullHref={f.view.stepHref}
                onMessage={() => f.onMessage(f.agentId)}
                onStop={v.onStop}
                onClose={f.onClose}
            />
        );
        const placement = followPlacement(st.width);
        if (placement === 'column') {
            return <div data-chat-context data-chat-follow={f.agentId} style="padding: var(--space-md);">{panel}</div>;
        }
        return <FollowDrawer placement={placement} label={`Following ${v.name}`} agentId={f.agentId} onClose={f.onClose} content={() => panel} />;
    };
}, { name: 'ChatFollowPanel' });
