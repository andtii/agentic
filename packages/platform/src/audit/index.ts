/** Audit — the inspectable record of every consequential action: approvals, delegations, environment choices, transitions, config changes (architecture §4 Audit; OPS-03, COL-09, AGT-06). */

export { AUDIT_ROLL_BATCH, AUDIT_WINDOW, AuditActor, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, type AuditMethods, type AuditPage, type AuditQuery } from './actor.js';
export {
    AUDIT_KINDS,
    assertAuditEvent,
    isAuditKind,
    type ApprovalRequestedData,
    type ApprovalResolvedData,
    type AuditDataByKind,
    type AuditEvent,
    type AuditEventBase,
    type AuditEventInput,
    type AuditKind,
    type ConfigVersionedData,
    type DelegationCreatedData,
    type EnvironmentChosenData,
    type MachinePairedData,
    type MachineRevokedData,
    type PluginGrantedData,
    type PluginToggledData,
    type ProposalReviewedData,
    type SecretOpenedData,
    type TaskTransitionData
} from './events.js';
export { AUDIT_TYPE, auditKey, auditMonth, auditMonthKey, parseAuditKey, type ParsedAuditKey } from './key.js';
export { auditPort, capturingAuditPort, recordAudit, type AuditHops, type AuditPort } from './port.js';
export { applyAuditEntry, initialAuditState, type AuditEntry, type AuditState } from './state.js';
