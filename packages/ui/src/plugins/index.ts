/**
 * Plugins (#232): what a page needs to show a plugin of the build and set it
 * up — the card, the readiness pill over core's `pluginReadiness`, and the
 * write-only secret field. The config form itself is `SchemaForm` in
 * `../forms`.
 */
export { READINESS, readinessDetail } from './readiness.js';
export { ReadinessBadge } from './ReadinessBadge.js';
export type { ReadinessBadgeProps } from './ReadinessBadge.js';
export { PluginCard } from './PluginCard.js';
export type { PluginCardProps } from './PluginCard.js';
export { SecretField } from './SecretField.js';
export type { SecretFieldProps } from './SecretField.js';
// `componentExportName(scope)` for the `ag-*` scopes these own — the fragment contract.
export { PluginCard as AgPluginCard } from './PluginCard.js';
export { SecretField as AgSecret } from './SecretField.js';
