/**
 * The chat-modes team parts (#1057, CHT-09, COL-09): the crew strip, the handoff line, the work card,
 * folded talk, the lane and the follow panel — presentational only (props in, events out), styled to
 * `docs/design/chat-modes/HANDOFF.md` → "Team", "Lanes". The web views wire the data in.
 */
export { aiCrewAnatomy, aiHandoffAnatomy, aiWorkCardAnatomy, aiFoldedTalkAnatomy, aiLaneAnatomy, aiFollowAnatomy, teamAnatomies, TEAM_STATES } from './anatomy.js';
export { CrewStrip, CrewStrip as AiCrew, CrewChip } from './CrewStrip.js';
export type { CrewStripProps, CrewChipProps } from './CrewStrip.js';
export { HandoffLine, HandoffLine as AiHandoff } from './HandoffLine.js';
export type { HandoffLineProps } from './HandoffLine.js';
export { WorkCard, WorkCard as AiWorkCard, WORK_CARD_STEPS } from './WorkCard.js';
export type { WorkCardProps } from './WorkCard.js';
export { FoldedTalk, FoldedTalk as AiFoldedTalk } from './FoldedTalk.js';
export type { FoldedTalkProps } from './FoldedTalk.js';
export { Lane, Lane as AiLane } from './Lane.js';
export type { LaneProps, LaneEntry, LaneQuestion } from './Lane.js';
export { FollowPanel, FollowPanel as AiFollow, FOLLOW_STEPS, FOLLOW_LINES } from './FollowPanel.js';
export type { FollowPanelProps } from './FollowPanel.js';
export { CREW_STATES, crewLifecycle, crewStateLabel, elapsedOf, formatWorkMeta, formatFoldedTalk } from './model.js';
export type { CrewState, CrewMember, TeamAgent, TeamLifecycle } from './model.js';
