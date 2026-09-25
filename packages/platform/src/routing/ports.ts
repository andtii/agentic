/**
 * Ports the Routing actor is composed with (architecture §7).
 *
 * The router never imports the Session or Machine definitions: an app builds
 * them (they take ports of their own) and hands them in as thunks, because
 * Session, Machine and Routing reference each other.
 */

import type { ChatFileStore, ChatId, EnvironmentId, MachineId, Principal, ProjectFeaturePlugin, ProjectRecord, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import type { AnyActorDefinition } from '@sigx/actors';
import type { AuditPort } from '../audit/port.js';
import type { WorkspaceStore } from '../workspace/ports.js';
import type { RuntimeCatalogue } from './factory.js';
import type { ToolFamilies } from './features.js';

/** A task placed in a project (#793): its feature hooks ran and its session is about to open, in `cwd`. */
export interface ProjectPlacement {
    readonly workspaceId: WorkspaceId;
    readonly project: ProjectRecord;
    readonly taskId: TaskId;
    readonly chatId?: ChatId;
    /** Absent on the API path (no folder, so no `beforeSession` ran). */
    readonly environmentId?: EnvironmentId;
    readonly machineId?: MachineId;
    /** The folder the session opens in — a feature's (a chat's worktree) or the route's. */
    readonly cwd?: string;
}

export interface RoutingPorts {
    /** The Session actor definition this app built (`defineSessionActor`). */
    readonly sessions: () => AnyActorDefinition;
    /** The Machine actor definition this app built (`defineMachineActor`). */
    readonly machines: () => AnyActorDefinition;
    /**
     * The Registry actor definition this app built (`defineRegistry`). With it, `run` asks `gate({ runtime })` once
     * before a route is written: a runtime plugin that is missing or disabled fails the task `plugin-disabled`, and the
     * answer rides on the session spec (`plugins`). Absent: nothing is gated, as before the catalogue.
     */
    readonly registry?: () => AnyActorDefinition;
    /**
     * The build's runtimes — the same catalogue the session factory has. A `local` runtime needs no environment; a
     * `daemon` one runs on a machine; an id it does not know fails the task `unknown-runtime`. Absent:
     * `anthropic-api` is local and every other id is daemon-hosted.
     */
    readonly runtimes?: RuntimeCatalogue;
    /**
     * The principal the router drives Task, Session, Machine and Agent with.
     * Default: the workspace's user (v1: `workspaceId === userId`, see
     * `auth/same-workspace.ts`), which every driver-facing policy admits.
     */
    readonly driver?: (workspaceId: WorkspaceId) => Principal;
    /** Where environment choices are recorded (`environment.chosen`, incl. a fallback; OPS-03). Default `auditPort()` — one-way to `{ws}:audit`. */
    readonly audit?: AuditPort;
    /**
     * Where chat attachment bytes live (#203) — R2 in the web app. The prompt's images are read from it
     * (after `Chat.fileAccess` as the task's agent) and inlined; absent, every attachment reaches the
     * model as a note (`hydrateChatFiles`).
     */
    readonly files?: ChatFileStore;
    /**
     * The project feature plugins this build ships, by plugin id (#332; the git plugin, #335). For a task in a
     * project, `run` calls each enabled one's `beforeSession` after the folder is resolved and before the session
     * opens, and merges every one's `instructions()` into the prompt's `## Project` section. An enabled feature
     * with no plugin here is skipped. Default: none.
     */
    readonly projectFeatures?: Readonly<Record<string, ProjectFeaturePlugin>>;
    /**
     * The tool families this build knows, by name (#737; PRJ-06): a feature the project enables that declares
     * `ui.tools` adds each family's grants to every session of the project, local and daemon, under the agent's tool
     * policy (`withFeatureTools`). A family not listed is skipped, and the task's timeline says so. Default
     * `DEFAULT_TOOL_FAMILIES` (`plan`).
     */
    readonly toolFamilies?: ToolFamilies;
    /**
     * Told of every placement in a project once its feature hooks ran (#793) — the app watches the project's repo and
     * links a chat's branch to its task (the Pulls actor). Fire and forget: never awaited, and a throw is logged and
     * never fails the placement. Default: none.
     */
    readonly placed?: (placement: ProjectPlacement) => void | Promise<void>;
    /**
     * How `endSession` (#399, OPS-10) deletes the ended session's record and its pages — the same store
     * `Workspace.deleteAll` purges through (`WorkspaceOptions.store`; each actor's own Durable Object in the web
     * app). Absent: the ended session is closed and unbound but its record and pages stay in storage.
     */
    readonly store?: WorkspaceStore;
    /** Clock for tests. Default `Date.now`. */
    readonly now?: () => number;
    /**
     * How long an implicit turn may run without carrying anything before the re-check cancels it (#605). Default
     * `GHOST_TURN_MS` (20 s).
     */
    readonly ghostTurnMs?: number;
    /** Session id allocation for tests. Default `createId('session')`. */
    readonly newSessionId?: () => SessionId;
}
