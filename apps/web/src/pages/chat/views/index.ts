/**
 * The chat views (#1058, CHT-09): the registry the page renders from. `pick.ts` names the view, the page
 * hands it one `ChatViewModel` (`types.ts`); Team (#1059) and Lanes (#1061) replace only their own folder,
 * the Follow panel (#1060) its own (`../follow`).
 */
import type { ChatViewName } from '../view-prefs';
import { FocusView } from './focus';
import { LanesView } from './lanes';
import { TeamView } from './team';

export const CHAT_VIEWS: Readonly<Record<ChatViewName, typeof FocusView>> = {
    focus: FocusView,
    team: TeamView,
    lanes: LanesView
};

export { FollowPanel } from '../follow';
export type { FollowModel, FollowPanelProps } from '../follow';
export type { ChatViewModel, ChatViewProps, LiveWork, ThreadInput } from './types';
