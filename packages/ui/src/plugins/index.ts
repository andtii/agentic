/**
 * Plugins (#232, #634): what a page needs to show a plugin of the build and
 * set it up — the catalogue row, the connector tile, the per-tool policy row,
 * the readiness pill over core's `pluginReadiness`, and the
 * write-only secret field. The config form itself is `SchemaForm` in
 * `../forms`.
 */
export { READINESS, readinessDetail } from './readiness.js';
export { ReadinessBadge } from './ReadinessBadge.js';
export type { ReadinessBadgeProps } from './ReadinessBadge.js';
export { PluginRow } from './PluginRow.js';
export type { PluginRowProps, PluginRowVariant } from './PluginRow.js';
export { ConnectorTile } from './ConnectorTile.js';
export type { ConnectorTileProps } from './ConnectorTile.js';
export { ToolPolicyRow } from './ToolPolicyRow.js';
export type { ToolPolicyRowProps } from './ToolPolicyRow.js';
export { SecretField } from './SecretField.js';
export type { SecretFieldProps } from './SecretField.js';
// `componentExportName(scope)` for the `ag-*` scopes these own — the fragment contract.
export { ReadinessBadge as AgReadiness } from './ReadinessBadge.js';
export { SecretField as AgSecret } from './SecretField.js';
