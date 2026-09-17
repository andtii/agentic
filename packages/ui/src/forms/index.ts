/**
 * Forms (issue #25): agent configuration, configuration versions, the
 * environment card and workspace settings, all on zero's `model=` form
 * contract — a `Field` around every control, a real `name` on every control
 * so the form posts pre-hydration, and one parser per form that reads that
 * post back into the same model the live binding writes.
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
    validateAgentDraft
} from './agent-model.js';
export type { AgentDraft, AgentErrors, AgentErrorKey, ApprovalCategory, ApprovalOutcome, ToolMode, LimitKey } from './agent-model.js';

export {
    SETTINGS_FIELDS,
    defaultWorkspaceSettings,
    toSettingsDraft,
    fromSettingsDraft,
    settingsDraftFromFormData,
    parseSettingsFormData,
    supportedTimeZones,
    validateSettingsDraft
} from './settings-model.js';
export type { SettingsDraft, SettingsErrors } from './settings-model.js';

export { TextField, TextareaField, SelectField, NumberField, SwitchField, MultiSelectField } from './fields.js';
export type { FieldOption, TextFieldProps, TextareaFieldProps, SelectFieldProps, NumberFieldProps, SwitchFieldProps, MultiSelectFieldProps } from './fields.js';

export { AgentForm } from './agent-form.js';
export type { AgentFormApi, AgentFormProps } from './agent-form.js';

export { ConfigVersions } from './config-versions.js';
export type { ConfigVersionsProps } from './config-versions.js';

export { EnvironmentCard, environmentStatus } from './environment-card.js';
export type { EnvironmentCardProps, EnvironmentState, EnvironmentStatus } from './environment-card.js';

export { SettingsForm } from './settings-form.js';
export type { SettingsFormApi, SettingsFormProps } from './settings-form.js';

export { MultiSelect } from '../_zero-gaps/multi-select.js';
export type { MultiSelectOption, MultiSelectProps } from '../_zero-gaps/multi-select.js';
