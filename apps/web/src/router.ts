import { createRouter, createWebHistory, createMemoryHistory, type RouteRecordRaw } from '@sigx/router';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { Chats } from './pages/Chats';
import { Tasks } from './pages/Tasks';
import { Agents } from './pages/Agents';
import { Agent } from './pages/Agent';
import { Task } from './pages/Task';
import { Session } from './pages/Session';
import { Machines } from './pages/Machines';
import { Machine } from './pages/Machine';
import { Schedules } from './pages/Schedules';
import { Plugins } from './pages/Plugins';
import { Plugin } from './pages/Plugin';
import { Settings } from './pages/Settings';
import { Pair } from './pages/Pair';
import { History } from './pages/History';
import { Usage } from './pages/Usage';

/** One route table for the browser and the server (docs/architecture.md §10). */
export const routes: RouteRecordRaw[] = [
    { path: '/', name: 'home', component: Home },
    { path: '/chats', name: 'chats', component: Chats },
    { path: '/chats/:id', name: 'chat', component: Chat },
    { path: '/agents', name: 'agents', component: Agents },
    { path: '/agents/:id', name: 'agent', component: Agent },
    { path: '/tasks', name: 'tasks', component: Tasks },
    { path: '/tasks/:id', name: 'task', component: Task },
    { path: '/sessions/:id', name: 'session', component: Session },
    { path: '/machines', name: 'machines', component: Machines },
    { path: '/machines/:id', name: 'machine', component: Machine },
    { path: '/schedules', name: 'schedules', component: Schedules },
    { path: '/plugins', name: 'plugins', component: Plugins },
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
