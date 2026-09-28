/**
 * The Follow panel (#1060 fills this folder; `docs/design/chat-modes/HANDOFF.md` → "Team", "Follow panel"):
 * an agent's live work in the right column — task, environment, last steps, the tail of its live output,
 * Message and Stop. Following never writes to the thread. Until #1060 it is a stub that renders nothing, and
 * the page keeps its context panel while nobody is followed.
 */
import { component, type Define } from 'sigx';
import type { SessionFeed } from '../live';
import type { ChatViewModel } from '../views/types';

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

export const FollowPanel = component<FollowPanelProps>(() => () => null, { name: 'ChatFollowPanel' });
