import { createRouter, createWebHistory, createMemoryHistory, type RouteRecordRaw } from '@sigx/router';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { Chats } from './pages/Chats';
import { NewChatEntry } from './pages/chat/NewChatEntry';
import { Tasks } from './pages/Tasks';
import { Agents } from './pages/Agents';
import { Agent } from './pages/Agent';
import { EditProject, NewProject, Projects } from './pages/Projects';
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

/** One route table for the browser and the server (docs/architecture.md §10). */
export const routes: RouteRecordRaw[] = [
    { path: '/', name: 'home', component: Home },
    { path: '/chats', name: 'chats', component: Chats },
    // `/chats/new` before `/chats/:id`, so "new" is never read as a chat id (#336: the daemon's deep link).
    { path: '/chats/new', name: 'chat-new', component: NewChatEntry },
    { path: '/chats/:id', name: 'chat', component: Chat },
    // `/projects/new` before `/projects/:id`, so "new" is never read as an id (#333).
    { path: '/projects', name: 'projects', component: Projects },
    { path: '/projects/new', name: 'project-new', component: NewProject },
    { path: '/projects/:id', name: 'project', component: EditProject },
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
