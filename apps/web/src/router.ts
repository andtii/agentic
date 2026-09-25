import { createRouter, createWebHistory, createMemoryHistory, type RouteRecordRaw } from '@sigx/router';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { Chats } from './pages/Chats';
import { NewChatEntry } from './pages/chat/NewChatEntry';
import { Tasks } from './pages/Tasks';
import { Agents } from './pages/Agents';
import { Agent } from './pages/Agent';
import { NewProject } from './pages/projects/new/NewProject';
import { ProjectsIndex } from './pages/projects/index/ProjectsIndex';
import { ProjectLinks } from './pages/projects/links/Links';
import { inProject } from './pages/projects/layout/ProjectLayout';
import { ProjectOverview } from './pages/projects/overview/Overview';
import { ProjectChats } from './pages/projects/chats/ProjectChats';
import { ProjectWork } from './pages/projects/work/WorkView';
import { ProjectWorkItem } from './pages/projects/work/WorkItemRoute';
import { ProjectRequests } from './pages/projects/requests/Requests';
import { ProjectPlan } from './pages/projects/features/plan/Plan';
import { ProjectSettings } from './pages/projects/settings/SettingsLayout';
import { ProjectCodeSection, ProjectFeatureSection } from './pages/projects/features/FeatureSection';
import { Task } from './pages/Task';
import { Session } from './pages/Session';
import { SessionChanges } from './pages/SessionChanges';
import { SessionFilesPage } from './pages/SessionFiles';
import { Machines } from './pages/Machines';
import { Machine } from './pages/Machine';
import { Schedules } from './pages/Schedules';
import { Plugins } from './pages/Plugins';
import { Plugin } from './pages/Plugin';
import { AddConnector } from './pages/AddConnector';
import { Settings } from './pages/Settings';
import { Pair } from './pages/Pair';
import { History } from './pages/History';
import { Usage } from './pages/Usage';
import { QuickAsk } from './pages/quick/QuickAsk';

/** One route table for the browser and the server (docs/architecture.md §10). */
export const routes: RouteRecordRaw[] = [
    { path: '/', name: 'home', component: Home },
    // The desktop app's quick-ask window (#849): rendered without the app shell.
    { path: '/quick', name: 'quick', component: QuickAsk },
    { path: '/chats', name: 'chats', component: Chats },
    // `/chats/new` before `/chats/:id`, so "new" is never read as a chat id (#336: the daemon's deep link).
    { path: '/chats/new', name: 'chat-new', component: NewChatEntry },
    { path: '/chats/:id', name: 'chat', component: Chat },
    // The projects redesign (#722, scaffold #725): the literal `/projects/links` and `/projects/new` before `/projects/:id`,
    // so neither is read as an id (#333). Every page under `/projects/:id` renders inside `ProjectLayout` (`inProject`).
    { path: '/projects', name: 'projects', component: ProjectsIndex },
    { path: '/projects/links', name: 'projects-links', component: ProjectLinks },
    { path: '/projects/new', name: 'project-new', component: NewProject },
    { path: '/projects/:id', name: 'project', component: inProject(ProjectOverview, 'ProjectOverviewRoute') },
    { path: '/projects/:id/chats', name: 'project-chats', component: inProject(ProjectChats, 'ProjectChatsRoute') },
    { path: '/projects/:id/work', name: 'project-work', component: inProject(ProjectWork, 'ProjectWorkRoute') },
    { path: '/projects/:id/work/:item', name: 'project-work-item', component: inProject(ProjectWorkItem, 'ProjectWorkItemRoute') },
    { path: '/projects/:id/requests', name: 'project-requests', component: inProject(ProjectRequests, 'ProjectRequestsRoute') },
    { path: '/projects/:id/plan', name: 'project-plan', component: inProject(ProjectPlan, 'ProjectPlanRoute') },
    { path: '/projects/:id/settings/:tab', name: 'project-settings', component: inProject(ProjectSettings, 'ProjectSettingsRoute') },
    // The git section's canonical route (#841); its old `f/agentic.feature.git` address redirects here, both before `f/:feature`.
    { path: '/projects/:id/code', name: 'project-code', component: inProject(ProjectCodeSection, 'ProjectCodeRoute') },
    { path: '/projects/:id/f/agentic.feature.git', name: 'project-git-legacy', redirect: (to) => `/projects/${String(to.params.id)}/code` },
    { path: '/projects/:id/f/:feature', name: 'project-feature', component: inProject(ProjectFeatureSection, 'ProjectFeatureRoute') },
    { path: '/agents', name: 'agents', component: Agents },
    { path: '/agents/:id', name: 'agent', component: Agent },
    { path: '/tasks', name: 'tasks', component: Tasks },
    { path: '/tasks/:id', name: 'task', component: Task },
    { path: '/sessions/:id', name: 'session', component: Session },
    // A session's folder (#564): what the agent changed, and a read-only browser of the folder.
    { path: '/sessions/:id/changes', name: 'session-changes', component: SessionChanges },
    { path: '/sessions/:id/files', name: 'session-files', component: SessionFilesPage },
    { path: '/machines', name: 'machines', component: Machines },
    { path: '/machines/:id', name: 'machine', component: Machine },
    { path: '/schedules', name: 'schedules', component: Schedules },
    { path: '/plugins', name: 'plugins', component: Plugins },
    // `/plugins/connectors/add` before `/plugins/:id`, so the add page is never read as a plugin id (#628).
    { path: '/plugins/connectors/add', name: 'connector-add', component: AddConnector },
    { path: '/plugins/:id', name: 'plugin', component: Plugin },
    { path: '/settings', name: 'settings', component: Settings },
    { path: '/pair', name: 'pair', component: Pair },
    { path: '/history', name: 'history', component: History },
    { path: '/usage', name: 'usage', component: Usage }
];

/** Browser: history API navigation. */
export function createAppRouter() {
    return createRouter({ history: createWebHistory(), routes });
}

/** Server: a fresh in-memory history per request, positioned at the requested URL. */
export function createServerRouter(url: string) {
    return createRouter({ history: createMemoryHistory({ initialLocation: url }), routes });
}
