/** The project settings tabs (#725), in strip and sub-menu order: `/projects/:id/settings/<tab>`. */
export const SETTINGS_TABS = [
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' },
    { id: 'folders', label: 'Folders' },
    { id: 'connectors', label: 'Connectors' },
    { id: 'features', label: 'Features' },
    { id: 'manager', label: 'Project manager' }
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

export const settingsTabOf = (id: unknown): (typeof SETTINGS_TABS)[number] | undefined => SETTINGS_TABS.find((t) => t.id === id);

export const settingsHref = (projectId: string, tab: SettingsTab): string => `/projects/${projectId}/settings/${tab}`;
