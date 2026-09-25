/**
 * Mock data for the project Overview (#722) — owned by #730, imported only by its own page and its test; nothing
 * shared re-exports it. The artboards' two homes: `agentic` (ProjectHome: a code project on alien01) and
 * "Field service event" (EventHome: no folder, runs on the platform). The event project is not in the mock
 * workspace's project list; the test renders its Overview over `MOCK_EVENT_PROJECT`.
 */
import type { ProjectId, ProjectRecord } from '@agentic/core';
import type { OverviewData } from '../../pages/projects/overview/model';
import { MOCK_NOW } from '../workspace';

const minutesAgo = (m: number): number => MOCK_NOW - m * 60_000;
const hoursAgo = (h: number): number => minutesAgo(h * 60);
const daysAgo = (d: number): number => hoursAgo(d * 24);

/** EventHome's project: no folder, calendar / plan / budget features, Atlas coordinating with Scout. */
export const MOCK_EVENT_PROJECT: ProjectRecord = {
    id: 'p_event' as ProjectId,
    name: 'Field service event',
    description: 'October field day for the service team',
    members: { agentIds: ['atlas', 'scout'] as never[], coordinator: 'atlas' as never },
    folders: {},
    connectors: [{ id: 'gmail' }],
    features: { 'agentic.feature.calendar': {}, 'agentic.feature.plan': {}, 'agentic.feature.budget': {} },
    createdAt: daysAgo(10),
    updatedAt: hoursAgo(1)
};

const AGENTIC: OverviewData = {
    moves: [
        { id: 'm_602', title: 'Make the drawer collapse below 768 px', detail: 'Merge #602 · green, Lint approved', href: '/projects/p_agentic/work/pr:602', ref: '#602', refIcon: 'branch', at: hoursAgo(2) },
        { id: 'm_605', title: 'History filter lists audit kinds', detail: 'Decide: merge #602 first, or let Forge rebase', href: '/projects/p_agentic/work/pr:605', ref: '#605', refIcon: 'branch', at: minutesAgo(40) },
        { id: 'm_rel', title: 'Release notes for 0.4', detail: 'Forge asks: include the plugin breaking change?', href: '/chats/c_rel04', ref: 'chat', refIcon: 'chats', at: minutesAgo(12) }
    ],
    chats: [
        { id: 'c_rel04', title: 'Release notes for 0.4', state: 'needs-you', lastBy: 'Forge', lastLine: 'Should the plugin kind rename go under breaking changes?', members: ['atlas', 'forge'], links: [{ label: 't_9a31', icon: 'check' }], at: minutesAgo(12) },
        { id: 'c_rings', title: 'Usage rings on the member card', state: 'working', lastBy: 'Forge', lastLine: 'size-limit failed, trimming the ring SVG before the push', members: ['forge'], links: [{ label: '#603', icon: 'branch' }, { label: 't_91a0', icon: 'check' }], at: minutesAgo(4) },
        { id: 'c_restructure', title: 'Plan the Projects restructure', state: 'working', lastBy: 'Atlas', lastLine: 'Split into 4 tasks, Forge takes the nav, Lint the review', members: ['atlas', 'forge', 'lint'], links: [{ label: '4 tasks', icon: 'check' }], at: minutesAgo(9) },
        { id: 'c_drawer', title: 'Drawer behaviour on tablets', state: 'idle', lastBy: 'You', lastLine: 'ok ship it as long as the spec covers 768', members: ['forge', 'lint'], links: [{ label: '#602', icon: 'branch' }, { label: '#598', icon: 'branch' }], at: hoursAgo(2) },
        { id: 'c_nuc', title: 'Why is nuc-lab offline?', state: 'idle', lastBy: 'Atlas', lastLine: 'Daemon lost its token after the reboot. Re-pair it from Machines.', members: ['atlas'], links: [], at: hoursAgo(3) },
        { id: 'c4', title: 'Release checklist', state: 'idle', lastBy: 'Lint', lastLine: 'runbook section 3 reads fine now', members: ['forge', 'lint'], links: [], at: hoursAgo(5) }
    ],
    schedules: [
        { id: 'sch_deps', title: 'Nightly dependency check', agentId: 'forge', next: 'tonight 02:00' }
    ]
};

const EVENT: OverviewData = {
    moves: [
        { id: 'm_venue', title: 'Confirm the venue booking', detail: 'Approve the email Atlas drafted to Kulturhuset', href: '/chats/c_venue', ref: 'gmail draft', refIcon: 'link', at: hoursAgo(3) },
        { id: 'm_catering', title: 'Catering: pick one of two quotes', detail: 'Scout compared 6 quotes and shortlisted 2', href: '/chats/c_caterers', ref: '2 quotes', at: hoursAgo(1) }
    ],
    chats: [
        { id: 'c_date', title: 'Find a date that suits everyone', state: 'working', lastBy: 'Atlas', lastLine: 'Checked 14 calendars; Thu 16 Oct works for all but one', members: ['atlas'], links: [{ label: '16 Oct', icon: 'schedules' }], at: minutesAgo(20) },
        { id: 'c_caterers', title: 'Caterers near the venue', state: 'working', lastBy: 'Scout', lastLine: '4 of 6 quotes in, two are vegetarian-first', members: ['scout'], links: [{ label: 'budget' }], at: hoursAgo(1) },
        { id: 'c_agenda', title: 'Agenda for the day', state: 'idle', lastBy: 'You', lastLine: 'keep the safety walkthrough before lunch', members: ['atlas'], links: [{ label: '3 items', icon: 'menu' }], at: daysAgo(1) }
    ],
    schedules: []
};

/** By project id. */
export const MOCK_PROJECT_OVERVIEW: Readonly<Record<string, OverviewData>> = {
    p_agentic: AGENTIC,
    p_event: EVENT
};
