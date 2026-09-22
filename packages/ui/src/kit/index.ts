/**
 * The app component kit (`docs/design/HANDOFF.md` → "Components"): the
 * `ag-*` scopes and the compositions over zero every page builds from.
 * The `Ag*` aliases are the fragment's `componentExportName(scope)` contract.
 */
import './globals.js';

export { kitAnatomies, agPillAnatomy, agAgentTileAnatomy, agEnvLineAnatomy, agNeedsItemAnatomy, agTaskNodeAnatomy, agConnectionAnatomy, agVersionAnatomy, agEnvCardAnatomy, agFailureAnatomy, agBannerAnatomy, agEmptyAnatomy, agPluginCardAnatomy, agSecretAnatomy, agMapFieldAnatomy, agQuotaAnatomy, agQuotaPanelAnatomy, agQuotaRingsAnatomy, agMarkdownAnatomy } from './anatomy.js';
export { recipes as kitRecipes } from './recipes.js';
export { kitScopes, TONES, NEEDS_KINDS } from './vocabulary.js';
export type { Tone, NeedsKind } from './vocabulary.js';
export { kitCss } from './css.js';
export { PILLS, pillFor, waitText } from './tone.js';
export type { PillSpec, PillStatus } from './tone.js';
export { Icon, ICON_NAMES } from './icons.js';
export type { IconName, IconProps } from './icons.js';
export { StatusPill, Tag, WaitReasonLine } from './StatusPill.js';
export { QuotaMeter, QuotaPanel, QuotaBadge, QuotaMeter as AgQuota, QuotaPanel as AgQuotaPanel } from './QuotaMeter.js';
export type { QuotaMeterProps, QuotaPanelProps, QuotaBadgeProps } from './QuotaMeter.js';
export { QuotaRings, QuotaRings as AgQuotaRings, ringWindows, ringLabel } from './QuotaRings.js';
export type { QuotaRingsProps } from './QuotaRings.js';
export { QUOTA_STALE_MS, quotaTone, quotaPercent, quotaShortLabel, quotaUsedText, resetsText, resetsShortText, ageText, isQuotaStale } from './quota.js';
export type { StatusPillProps, TagProps, WaitReasonLineProps } from './StatusPill.js';
export { AgentTile, AGENT_HUE_SLOTS, hueFor, monogramOf } from './AgentTile.js';
export type { AgentTileProps, AgentHue, TileSize } from './AgentTile.js';
export { EnvironmentLine } from './EnvironmentLine.js';
export type { EnvironmentLineProps, EnvironmentParts } from './EnvironmentLine.js';
export { NeedsItem } from './NeedsItem.js';
export type { NeedsItemProps } from './NeedsItem.js';
export { Button, BUTTON_INTENTS, buttonAxes } from './Button.js';
export type { ButtonProps, ButtonIntent } from './Button.js';
export { Segmented, segmentStyle } from './Segmented.js';
export type { SegmentedProps, SegmentedOption } from './Segmented.js';
export { Switch } from './Switch.js';
export type { SwitchProps } from './Switch.js';
export { MultiSelect as ChipInput } from '../_zero-gaps/multi-select.js';
export type { MultiSelectProps as ChipInputProps, MultiSelectOption as ChipInputOption } from '../_zero-gaps/multi-select.js';
export { DataTable, parseCols } from './DataTable.js';
export type { DataTableProps, DataColumn } from './DataTable.js';
export { TaskNode } from './TaskNode.js';
export type { TaskNodeProps } from './TaskNode.js';
export { TimelineList } from './TimelineList.js';
export type { TimelineListProps, TimelineEntry } from './TimelineList.js';
export { VersionItem } from './VersionItem.js';
export type { VersionItemProps, VersionState } from './VersionItem.js';
export { ConfirmDialog } from './ConfirmDialog.js';
export type { ConfirmDialogProps } from './ConfirmDialog.js';
export { MarkdownViewer, markdownHighlighter } from './MarkdownViewer.js';
export type { MarkdownViewerProps } from './MarkdownViewer.js';
export { MarkdownDialog } from './MarkdownDialog.js';
export type { MarkdownDialogProps } from './MarkdownDialog.js';
export { ConnectionStrip } from './ConnectionStrip.js';
export type { ConnectionStripProps, ConnectionRow } from './ConnectionStrip.js';
export { SectionHeading, Label } from './text.js';
export type { SectionHeadingProps, LabelProps } from './text.js';
export * from './states/index.js';

// `componentExportName(scope)` for every `ag-*` scope — the fragment contract.
export { StatusPill as AgPill } from './StatusPill.js';
export { AgentTile as AgAgentTile } from './AgentTile.js';
export { EnvironmentLine as AgEnvLine } from './EnvironmentLine.js';
export { NeedsItem as AgNeedsItem } from './NeedsItem.js';
export { TaskNode as AgTaskNode } from './TaskNode.js';
export { ConnectionStrip as AgConnection } from './ConnectionStrip.js';
export { VersionItem as AgVersion } from './VersionItem.js';
export { EnvironmentCard as AgEnvCard, authPill, authFixLine } from '../forms/environment-card.js';
export type { DefaultForAgent } from '../forms/environment-card.js';
export { FailureCard as AgFailure } from './states/FailureCard.js';
export { OfflineBanner as AgBanner } from './states/OfflineBanner.js';
export { EmptyState as AgEmpty } from './states/EmptyState.js';
export { MarkdownViewer as AgMarkdown } from './MarkdownViewer.js';
