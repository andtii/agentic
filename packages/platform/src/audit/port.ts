/**
 * The seam between an actor performing a consequential action and the
 * record of it (architecture §4 Audit). `recordAudit(ctx, ws, event)` is a
 * ONE-WAY hop to the workspace's live log: it resolves once the call is
 * accepted, and a log that cannot be reached — not registered, refusing,
 * gone — never fails the turn that did the work. Audit is a record of what
 * happened, not a gate on it.
 *
 * `AuditPort` is the same contract behind an interface, for the actors
 * built over ports (Session, Routing) so an app or a test can swap the
 * default for a capturing one.
 */

import type { WorkspaceId } from '@agentic/core';
import type { ActorClientWith, AnyActorDefinition } from '@sigx/actors';
import { AuditActor } from './actor.js';
import type { AuditEventInput } from './events.js';
import { auditKey } from './key.js';

/** The slice of an `ActorContext` an emitter needs: the hop to another actor (`ctx` itself satisfies it). */
export interface AuditHops {
    actor<D extends AnyActorDefinition>(def: D, key: string): ActorClientWith<D>;
}

export interface AuditPort {
    /** Record one occurrence for `workspaceId`. Never throws; resolves once the record is on its way. */
    record(hops: AuditHops, workspaceId: WorkspaceId, event: AuditEventInput): Promise<void>;
}

/** The production port: `AuditActor.record` on `{ws}:audit`, one-way, failures dropped. */
export function auditPort(): AuditPort {
    return {
        async record(hops, workspaceId, event) {
            try {
                await hops
                    .actor(AuditActor, auditKey(workspaceId))
                    .with({ oneWay: true })
                    .record(event);
            } catch {
                // The history never stalls or fails the work it records.
            }
        }
    };
}

const DEFAULT_PORT = auditPort();

/** `auditPort().record(...)` — what an actor without ports of its own calls (`recordAudit(ctx, workspaceId, event)`). */
export function recordAudit(hops: AuditHops, workspaceId: WorkspaceId, event: AuditEventInput): Promise<void> {
    return DEFAULT_PORT.record(hops, workspaceId, event);
}

/** A test double: keeps every event it was handed, in order, and records nothing. */
export function capturingAuditPort(): AuditPort & { readonly events: AuditEventInput[] } {
    const events: AuditEventInput[] = [];
    return {
        events,
        async record(_hops, _workspaceId, event) {
            events.push(event);
        }
    };
}
