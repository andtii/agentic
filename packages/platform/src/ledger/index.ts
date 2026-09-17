/** Ledger actor — usage and cost per turn / task / agent, estimates flagged, budgets enforced (architecture §4 Ledger, §5a limits, §7). */

export { LedgerActor, type LedgerMethods, type RowsQuery } from './actor.js';
export { BUDGET_ERROR_CODE, budgetError, checkBudget, isBudgetFailure, remainingBudget, type BudgetVerdict } from './budget.js';
export { LEDGER_TYPE, ledgerKey, ledgerMonth, parseLedgerKey } from './key.js';
export { ledgerCorrectionLedger, ledgerRecorder, type ActorHops, type LedgerRecorderOptions, type UsageRecorder, type UsageVerdict } from './recorder.js';
export { applyLedgerEntry, correctionKey, initialLedgerState, type CorrectionKind, type CorrectionTally, type LedgerEntry, type LedgerRow, type LedgerState } from './state.js';
export { UNATTRIBUTED, dayOf, qualityOf, summarize, type DataQuality, type LedgerGroup, type LedgerSummary, type LedgerTotals, type SummaryBy, type SummaryOptions } from './summary.js';
