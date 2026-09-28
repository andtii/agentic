/**
 * Team (#1059 fills this folder; `docs/design/chat-modes/HANDOFF.md` → "Team"): the view for two or more
 * agents at work — a crew strip, one-line handoffs, a work card per agent per assignment, folded talk and
 * questions for you. Until #1059 it is a stub over Focus, at Team's own detail default (Messages).
 */
import { component } from 'sigx';
import { FocusView } from '../focus';
import type { ChatViewProps } from '../types';

export type TeamViewProps = ChatViewProps;

export const TeamView = component<TeamViewProps>(({ props }) => () => <FocusView view={props.view} />, { name: 'ChatTeamView' });
