/**
 * `/projects/:id/settings/:tab` (#725): the settings tab strip over the tab's page. Each tab is its own folder and
 * issue — General, Members, Folders, Connectors (#733), Features (#736), Project manager (#760) — so this file does
 * not change when they land.
 */
import { component } from 'sigx';
import { Link, useRoute } from '@sigx/router';
import { EmptyState } from '@agentic/ui';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { projectTrail } from '../layout/trail';
import type { ProjectPage, ProjectPageProps } from '../layout/types';
import { ProjectConnectors } from './connectors/Connectors';
import { ProjectFeatures } from './features/Features';
import { ProjectFolders } from './folders/Folders';
import { ProjectGeneral } from './general/General';
import { ProjectManager } from './manager/Manager';
import { ProjectMembers } from './members/Members';
import { SETTINGS_TABS, settingsHref, settingsTabOf, type SettingsTab } from './tabs';

const TAB_PAGES: Readonly<Record<SettingsTab, ProjectPage>> = {
    general: ProjectGeneral,
    members: ProjectMembers,
    folders: ProjectFolders,
    connectors: ProjectConnectors,
    features: ProjectFeatures,
    manager: ProjectManager
};

defineTopbar('project-settings', (route) => {
    const id = String(route.params.id);
    const tab = settingsTabOf(route.params.tab);
    return { trail: projectTrail(route, { label: 'Settings', href: settingsHref(id, 'general') }, ...(tab ? [{ label: tab.label, href: route.path }] : [])) };
});

export const ProjectSettings = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    return () => {
        const tab = settingsTabOf(route.params.tab);
        const Tab = tab ? TAB_PAGES[tab.id] : undefined;
        return (
            <Page title="Settings" page="project-settings" hideTitle>
                <nav aria-label="Settings" data-settings-tabs="">
                    {SETTINGS_TABS.map((t) => (
                        <Link to={settingsHref(props.project.id, t.id)} aria-current={t.id === tab?.id ? 'page' : undefined}>{t.label}</Link>
                    ))}
                </nav>
                {Tab
                    ? <Tab project={props.project} />
                    : <EmptyState variant="generic" title="No such settings tab" caption={`Projects have no ${String(route.params.tab)} settings.`} />}
            </Page>
        );
    };
}, { name: 'ProjectSettings' });
