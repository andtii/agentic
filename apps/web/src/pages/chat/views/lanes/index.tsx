/**
 * Lanes (#1061 fills this folder; `docs/design/chat-modes/HANDOFF.md` → "Lanes"): pinned only — the
 * coordinator's latest message on top, then a column per agent at work. Until #1061 it is a stub over Focus.
 */
import { component } from 'sigx';
import { FocusView } from '../focus';
import type { ChatViewProps } from '../types';

export type LanesViewProps = ChatViewProps;

export const LanesView = component<LanesViewProps>(({ props }) => () => <FocusView view={props.view} />, { name: 'ChatLanesView' });
