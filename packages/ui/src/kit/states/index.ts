/**
 * The states (`docs/design/HANDOFF.md` → "Failure distinction", "Edge
 * cases", loading): the six named failure cards, the offline banner, the
 * events-lost line, the connection strip's rows, the empty states and the
 * skeleton presets. Pages and the failure-distinction wiring (#46) compose
 * these; nothing here reads a live signal.
 */
export { FAILURE_KINDS, FAILURES, FAILURE_AXES, failureSpec, NEEDS_KINDS } from './kinds.js';
export type { FailureKind, FailureAxis, FailureSpec, NeedsKind } from './kinds.js';
export { FailureCard } from './FailureCard.js';
export type { FailureCardProps, FailureAction } from './FailureCard.js';
export { OfflineBanner } from './OfflineBanner.js';
export type { OfflineBannerProps } from './OfflineBanner.js';
export { EventsLostRow, eventsLostText } from './EventsLostRow.js';
export type { EventsLostRowProps } from './EventsLostRow.js';
export { browserRow, machineRow, connectionRows } from './connection.js';
export type { BrowserConnection, MachineConnection } from './connection.js';
export { EmptyState, EMPTY_STATES, EMPTY_VARIANTS } from './EmptyState.js';
export type { EmptyStateProps, EmptyVariant } from './EmptyState.js';
export { TableSkeleton, CardSkeleton, RailSkeleton } from './Skeletons.js';
export type { TableSkeletonProps, CardSkeletonProps, RailSkeletonProps } from './Skeletons.js';
