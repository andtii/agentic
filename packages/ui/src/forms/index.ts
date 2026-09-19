/**
 * Forms (issue #25): agent configuration, configuration versions, the
 * environment card, workspace settings and the working-folder picker
 * (#191), all on zero's `model=` form contract — a `Field` around every
 * control, a real `name` on every control so the form posts pre-hydration,
 * and one parser per form that reads that post back into the same model
 * the live binding writes.
 */

export { text, list, flag, number, json } from './form-data.js';

export {
    AGENT_FIELDS,
    AGENT_NAME_MAX,
    APPROVAL_CATEGORIES,
    APPROVAL_OUTCOMES,
    TOOL_MODES,
    OFFLINE_POLICIES,
    LIMIT_KEYS,
    defaultAgentConfig,
    encodeSkill,
    decodeSkill,
    toAgentDraft,
    fromAgentDraft,
    agentDraftFromFormData,
    parseAgentFormData,
    validateAgentDraft,
    CUSTOM_MODEL,
    modelChoice
} from './agent-model.js';
export type { AgentDraft, AgentErrors, AgentErrorKey, ApprovalCategory, ApprovalOutcome, ToolMode, LimitKey, RuntimeOption } from './agent-model.js';

export {
    SETTINGS_FIELDS,
    defaultSettingsFormValue,
    toSettingsDraft,
    fromSettingsDraft,
    settingsDraftFromFormData,
    parseSettingsFormData,
    supportedTimeZones,
    validateSettingsDraft
} from './settings-model.js';
export type { SettingsDraft, SettingsErrors, SettingsFormValue } from './settings-model.js';

export { TextField, TextareaField, SelectField, NumberField, SwitchField, MultiSelectField, MapField } from './fields.js';
export type { FieldOption, TextFieldProps, TextareaFieldProps, SelectFieldProps, NumberFieldProps, SwitchFieldProps, MultiSelectFieldProps, MapFieldProps } from './fields.js';

export { schemaFields, schemaLabel, toSchemaDraft, fromSchemaDraft, validateSchemaDraft } from './schema-model.js';
export type { SchemaDraft, SchemaErrors, SchemaField, SchemaFieldKind, MapRow } from './schema-model.js';
export { SchemaForm } from './schema-form.js';
export type { SchemaFormApi, SchemaFormProps } from './schema-form.js';
// `componentExportName(scope)` for the map field's `ag-*` scope — the fragment contract.
export { MapField as AgMapField } from './fields.js';

export { AgentForm } from './agent-form.js';
export type { AgentFormApi, AgentFormProps, AgentFormRailProps, AgentFormLayout, AgentFormWorkdirProps } from './agent-form.js';

export { ConfigVersions } from './config-versions.js';
export type { ConfigVersionsProps } from './config-versions.js';

export { EnvironmentCard, environmentStatus } from './environment-card.js';
export type { EnvironmentCardProps, EnvironmentState, EnvironmentStatus } from './environment-card.js';

export { SettingsForm } from './settings-form.js';
export type { SettingsFormApi, SettingsFormProps } from './settings-form.js';

export { MultiSelect } from '../_zero-gaps/multi-select.js';
export type { MultiSelectOption, MultiSelectProps } from '../_zero-gaps/multi-select.js';

export { WorkdirField } from './workdir-field.js';
export type { WorkdirFieldProps } from './workdir-field.js';
export { WorkdirDialog, gitBadgeText } from './workdir-dialog.js';
export type { WorkdirDialogProps } from './workdir-dialog.js';
export { WORKDIR_EMPTY, FS_ERROR_TEXT, workdirLabel, workdirCrumbs, middleTruncate, samePath, fsErrorText, toWorkdirEnvironment } from './workdir-model.js';
export type { WorkdirEnvironment, WorkdirRecent, WorkdirWorktreeRequest, WorkdirCrumb } from './workdir-model.js';
// `componentExportName(scope)` for the picker's `ag-*` scopes — the fragment contract.
export { WorkdirField as AgWorkdir } from './workdir-field.js';
export { WorkdirDialog as AgWorkdirPicker } from './workdir-dialog.js';
