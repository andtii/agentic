/**
 * The chat-view seam (#1058): what the page hands every view. The page (mock `Chat.tsx`, live
 * `LiveChat.tsx`) builds one `ChatViewModel` and renders the view `views/index.ts` names for it, so
 * Team (#1059), Lanes (#1061) and Follow (#1060) replace only their own folder.
 */
import type { Define } from 'sigx';
import type { AgentTranscript } from '@sigx/ai-agent/app';
import type { AgentHue, DescribeFn, DescribeRequestFn, DetailLevel, PullLinksFn, RespondFn, StepHrefFn, ThreadInsert, ToolLinksFn, ToolMetaFn } from '@agentic/ui';
import type { AgentMessage } from '@sigx/ai-agent/app';
import type { MockChatMember } from '../../../mock/workspace';
import type { AgentLookup, SessionFeed } from '../live';

/** The thread's own inputs, as the page reads them: what `Thread` takes besides the detail level. */
export interface ThreadInput {
    readonly transcript: AgentTranscript;
    readonly describe?: DescribeFn;
    readonly inserts?: readonly ThreadInsert[];
    readonly toolMeta?: ToolMetaFn;
    readonly toolLinks?: ToolLinksFn;
    readonly pullLinks?: PullLinksFn;
    readonly describeRequest?: DescribeRequestFn;
    readonly logHref?: string;
    readonly hasEarlier?: boolean;
    readonly onEarlier?: () => void;
    readonly onRespond?: RespondFn;
}

/** One agent at work right now: the live line under the last turn (Focus), a crew chip (Team). */
export interface LiveWork {
    readonly agentId: string;
    readonly name: string;
    readonly hue?: AgentHue;
    /** What it is doing now: `Edit · packages/ui/package.json`. */
    readonly step?: string;
    /** When the turn started (epoch ms). */
    readonly startedAt: number;
    /** Stop it (`Session.cancel` through its feed); absent, no Stop. */
    readonly onStop?: () => void;
}

export interface ChatViewModel {
    readonly chatId: string;
    /** The rendered transcript and its row callbacks. */
    readonly thread: ThreadInput;
    readonly detail: DetailLevel;
    /** A message's steps box state as the viewer left it; `undefined` lets the box decide (a stopping failure opens it). */
    readonly stepsOpen: (message: AgentMessage) => boolean | undefined;
    readonly onStepsToggle: (message: AgentMessage, open: boolean) => void;
    /** `Full output` on a step: the step in Session. */
    readonly stepHref: StepHrefFn;
    /** The agents at work now, in member order. */
    readonly live: readonly LiveWork[];
    readonly members: readonly MockChatMember[];
    readonly lookup: AgentLookup;
    /** Each active session's feed (live); none on the mock page. */
    readonly feeds: readonly SessionFeed[];
    /** The agent that answers when a message @-mentions no one. */
    readonly coordinator?: string;
    /** The agent the Follow panel shows; `null` when none. */
    readonly followed: string | null;
    /** Follow an agent (`null` stops following). */
    readonly onFollow: (agentId: string | null) => void;
}

/** Every view takes the one model. */
export type ChatViewProps = Define.Prop<'view', ChatViewModel, true>;
