/**
 * Incoming Gmail starts agent work (#535; AST-09, PLG-01 `trigger`): the
 * Schedule `TriggerPort` for an entry that watches a connector
 * (`source: { kind: 'connector', connector, query? }`). Every other firing
 * goes to the platform's own trigger (`scheduleTrigger`) unchanged.
 *
 * One firing is one poll, as the workspace OWNER (the Registry, the plugin's
 * secrets and the workspace's `ConnectorAccounts`, each under its own
 * policy — the engine is the same one the sign-in routes build):
 *
 * - the connector's plugin off → nothing is read, the entry stays on (it
 *   polls again once the plugin is back on);
 * - no account on the record, the account gone, or one whose sign-in
 *   expired or was revoked (`needsReauth`) → the entry PAUSES itself (the
 *   Schedule turns it off with the reason) and one Inbox notification says
 *   to reconnect — never a crash loop against Google;
 * - otherwise `pollGmail` (`@agentic/connectors`) and, per new message, ONE
 *   task for the entry's agent: `origin { kind: 'trigger', triggerId: the
 *   schedule id }`, the entry's prompt as the objective, the From / Subject /
 *   snippet / id as context. The task id is a pure function of the entry
 *   and the message and `Task.create` is idempotent, so a re-poll — or a
 *   retried firing that threw half-way — never starts a second turn. The
 *   cursor the poll returns is saved by the Schedule in the same turn
 *   (`TriggerResult.cursor`), so the next poll skips what was delivered.
 *
 * A failure worth retrying (Google down, a network error) throws, and the
 * Schedule retries the occurrence, then drops it — the cursor did not move,
 * so the next occurrence reads the same window again.
 */
import type { AgentId, ScheduleId, TaskContract, TaskId, WorkspaceId } from '@agentic/core';
import { CONNECTOR_ENGINE_SECRET, gmailArrivalText, pollGmail, runsTrigger, GMAIL_NEW_EMAIL_TRIGGER } from '@agentic/connectors';
import { Inbox, Registry, TaskActor, asPrincipal, inboxKey, registryKey, taskKey, userPrincipal, type ScheduleFired, type TriggerHop, type TriggerPort, type TriggerResult } from '@agentic/platform';
import { actor } from '@sigx/actors';
import { openPluginSecret, workspaceConnectorEngine, type ConnectorHttp, type ConnectorRegistry } from './engine';
import { connectorPluginPage, connectorRedirectUri } from './paths';

export interface ConnectorTriggerOptions {
    /** Every firing that watches no connector — the platform's `scheduleTrigger`. */
    readonly fallback: TriggerPort;
    /** Start a task that landed `queued` (`Routing.run` as the owner). Fire and forget: a poll never waits on a turn. */
    readonly route: (workspaceId: WorkspaceId, taskId: TaskId) => void;
    /** The deployment's origin; an engine built for a poll never begins a sign-in, so it is only parsed. */
    readonly origin?: () => string | undefined;
    /** `fetch` replacement for the provider (tests). */
    readonly http?: ConnectorHttp;
}

/** What an agent is asked when the entry has no prompt of its own. */
export const DEFAULT_TRIGGER_OBJECTIVE = 'A new email arrived. Read it and handle it as your instructions say.';

/** The task one message starts — deterministic, so a re-poll finds the task it already made. */
export function triggeredTaskId(scheduleId: ScheduleId, itemId: string): TaskId {
    return `task_${scheduleId}_m_${itemId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)}` as TaskId;
}

const PLACEHOLDER_ORIGIN = 'http://localhost';

export function connectorTrigger(options: ConnectorTriggerOptions): TriggerPort {
    return {
        async fired(event, hop) {
            if (event.source?.kind !== 'connector') return options.fallback.fired(event, hop);
            return pollConnector(event, hop, options);
        }
    };
}

async function pollConnector(event: ScheduleFired, hop: TriggerHop, options: ConnectorTriggerOptions): Promise<TriggerResult | undefined> {
    const source = event.source!;
    const pluginId = source.connector;
    const ws = event.workspaceId;
    const page = connectorPluginPage(pluginId);
    const pause = async (reason: string): Promise<TriggerResult> => {
        // One notification per pause: the entry is off after this firing, so it cannot repeat.
        await hop.actor(Inbox, inboxKey(ws)).push({
            kind: 'reminder',
            title: `“${event.title}” is paused`,
            body: `${reason} Then turn the trigger back on at ${page}.`,
            ref: { kind: 'schedule', scheduleId: event.scheduleId }
        });
        return { pause: reason };
    };
    if (event.agentId === undefined) return pause('The trigger names no agent to wake.');

    const owner = userPrincipal(ws, ws);
    const registry = actor(Registry, registryKey(ws)).with({ context: asPrincipal(owner) }) as unknown as ConnectorRegistry;
    const plugin = await registry.get(pluginId);
    if (!plugin) return pause(`This workspace has no “${pluginId}” connector.`);
    // Off: nothing is read, and the entry polls again once the plugin is back on (AC-13: turning a plugin off refuses new use).
    if (!plugin.enabled) return undefined;
    const record = await registry.getConnector(pluginId);
    if (!record || record.transport !== 'conduit' || record.connector === undefined || record.account === undefined) return pause(`${pluginId} is not connected: connect it at ${page}.`);
    if (!runsTrigger(record.connector, GMAIL_NEW_EMAIL_TRIGGER)) return pause(`${record.connector} has no trigger this deployment runs.`);
    const engineSecret = await openPluginSecret(registry, CONNECTOR_ENGINE_SECRET, pluginId);
    if (engineSecret === undefined) return pause(`${pluginId}'s account cannot be opened: connect it again at ${page}.`);

    const engine = workspaceConnectorEngine({
        workspaceId: ws,
        principal: owner,
        secret: (name) => openPluginSecret(registry, name, pluginId),
        engineSecret,
        redirectUri: connectorRedirectUri(options.origin?.() ?? PLACEHOLDER_ORIGIN),
        ...(options.http ? { http: options.http } : {})
    });
    const account = await engine.accounts.get(record.account, ws);
    if (!account) return pause(`${pluginId}'s connected account is gone: connect it again at ${page}.`);
    const reconnect = `The sign-in for ${account.displayName ?? pluginId} expired or was revoked: reconnect it at ${page}.`;
    if (account.status === 'needsReauth') return pause(reconnect);

    const poll = await pollGmail(engine, { account: record.account, owner: ws, connector: record.connector, ...(source.query ? { query: source.query } : {}), ...(event.cursor !== undefined ? { cursor: event.cursor } : {}), now: event.firedAt });
    if (poll.kind === 'needs-reauth') return pause(reconnect);

    const agentId: AgentId = event.agentId;
    for (const arrival of poll.arrivals) {
        const taskId = triggeredTaskId(event.scheduleId, arrival.id);
        const contract: TaskContract = {
            objective: event.prompt?.trim() || DEFAULT_TRIGGER_OBJECTIVE,
            origin: { kind: 'trigger', triggerId: event.scheduleId },
            assignee: agentId,
            context: [{ type: 'text', text: gmailArrivalText(arrival, pluginId) }],
            constraints: {},
            ...(event.environmentId !== undefined ? { environmentId: event.environmentId } : {}),
            ...(event.workdir !== undefined && event.environmentId !== undefined ? { workdir: event.workdir } : {}),
            ...(event.projectId !== undefined ? { projectId: event.projectId } : {}),
            ...(event.machineId !== undefined ? { machineId: event.machineId } : {})
        };
        const view = await hop.actor(TaskActor, taskKey(ws, taskId)).create(contract, { owner: agentId });
        // Already routed (an earlier poll or attempt made it): the message has had its turn.
        if (view.status === 'queued') options.route(ws, taskId);
    }
    return { cursor: poll.cursor };
}
