/**
 * Autopilot (#743): the state machine — fix checks up to the attempt limit then give up, answer new threads, rebase
 * then stop on conflicts, merge when green through `ask on merge`, one turn at a time, take over / stop / resume —
 * and `driveAutopilot` taking the actions through a fake port.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, Autopilot, ChatId, PullCheck, PullRequest, PullThread, TaskId } from '@agentic/core';
import {
    ASK_ON_MERGE,
    AUTOPILOT_SETTLE_MS,
    AUTOPILOT_TURN_STALE_MS,
    autopilotActivity,
    autopilotMergeAnswered,
    autopilotTurnEnded,
    driveAutopilot,
    NEW_AUTOPILOT_RUN,
    resumeAutopilot,
    stepAutopilot,
    stopAutopilot,
    takeOverAutopilot,
    withAutopilotRun,
    type AutopilotAction,
    type AutopilotPort,
    type AutopilotRun
} from '../../src/pulls/autopilot';

const forge = 'agt_forge' as AgentId;
const chat = 'cht_1' as ChatId;
const task = 't_1' as TaskId;

const pilot = (over: Partial<Autopilot> = {}): Autopilot => ({ agentId: forge, fixChecks: true, maxAttempts: 3, answerThreads: true, rebase: true, mergeWhenGreen: true, ...over });
const check = (name: string, state: PullCheck['state'], detail?: string): PullCheck => ({ name, state, ...(detail ? { detail } : {}) });
const thread = (id: string, over: Partial<PullThread> = {}): PullThread => ({ id, author: 'lint', body: `thread ${id}`, state: 'open', ...over });

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    provider: 'github',
    repo: 'o/r',
    number: 603,
    title: 'PR 603',
    url: 'https://github.com/o/r/pull/603',
    head: '603-x',
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [check('lint', 'passed')],
    review: { state: 'none', reviewers: [], threads: [] },
    mergeable: true,
    autopilot: pilot(),
    chatId: chat,
    taskId: task,
    ...over
});

const failing = (detail = 'size-limit: 12.1 kB > 12 kB'): PullRequest => pr({ checks: [check('lint', 'passed'), check('size', 'failed', detail)] });
const running = (): PullRequest => pr({ checks: [check('lint', 'passed'), check('size', 'running')] });
const green = (): PullRequest => pr({ review: { state: 'approved', reviewers: [], threads: [] } });

/** Step, and let the turn end and settle, so the next step can act. */
function stepAndSettle(run: AutopilotRun, p: PullRequest, now: number): { run: AutopilotRun; actions: readonly AutopilotAction[] } {
    const step = stepAutopilot(p.autopilot, run, p, now);
    return { run: autopilotTurnEnded(step.run, now + 1), actions: step.actions };
}

describe('fixChecks', () => {
    it('starts a turn in the PR chat with the failure detail, attempt 1 of 3', () => {
        const { run, actions } = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, failing(), 0);
        expect(actions).toHaveLength(1);
        const a = actions[0]!;
        expect(a.kind).toBe('turn');
        if (a.kind !== 'turn') return;
        expect(a).toMatchObject({ turn: 'fix', agentId: forge, chatId: chat, taskId: task });
        expect(a.text).toContain('size-limit: 12.1 kB > 12 kB');
        expect(a.text).toContain('Attempt 1 of 3');
        expect(run.attempts).toBe(1);
        expect(run.turn).toMatchObject({ kind: 'fix', checks: ['size'] });
        expect(autopilotActivity(pilot(), run, failing())).toBe('Fixing size · attempt 1 of 3');
    });

    it('starts nothing while its turn holds the PR, nor while a check still runs', () => {
        const first = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, failing(), 0);
        expect(stepAutopilot(pilot(), first.run, failing(), 1000).actions).toEqual([]);
        // The push started the checks: the turn is over, and a running check is waited for.
        const pending = stepAutopilot(pilot(), first.run, running(), 2000);
        expect(pending.actions).toEqual([]);
        expect(pending.run.turn).toBeUndefined();
        expect(pending.run.attempts).toBe(1);
    });

    it('gives up after 3 attempts and makes it your move', () => {
        let run = NEW_AUTOPILOT_RUN;
        let now = 0;
        for (const n of [1, 2, 3]) {
            const step = stepAutopilot(pilot(), run, failing(), now);
            expect(step.actions.map((a) => a.kind)).toEqual(['turn']);
            expect(step.run.attempts).toBe(n);
            run = step.run;
            // The agent pushed, the checks ran, and failed again.
            run = stepAutopilot(pilot(), run, running(), now + 10).run;
            now += 1000;
        }
        const last = stepAutopilot(pilot(), run, failing(), now);
        expect(last.actions).toHaveLength(1);
        const a = last.actions[0]!;
        expect(a.kind).toBe('your-move');
        if (a.kind !== 'your-move') return;
        expect(a.stop.reason).toBe('gave-up');
        expect(a.stop.detail).toContain('after 3 attempts');
        expect(last.run.stopped?.reason).toBe('gave-up');
        // Stopped: nothing more until resumed.
        expect(stepAutopilot(pilot(), last.run, failing(), now + 1).actions).toEqual([]);
        expect(autopilotActivity(pilot(), last.run, failing())).toContain('Gave up');
        // Resumed: a fresh count.
        const again = stepAutopilot(pilot(), resumeAutopilot(last.run), failing(), now + 2);
        expect(again.run.attempts).toBe(1);
    });

    it('moves to the next attempt when a turn ended without a push, after the settle window', () => {
        const first = stepAndSettle(NEW_AUTOPILOT_RUN, failing(), 0);
        expect(stepAutopilot(pilot(), first.run, failing(), AUTOPILOT_SETTLE_MS - 10).actions).toEqual([]);
        const second = stepAutopilot(pilot(), first.run, failing(), AUTOPILOT_SETTLE_MS + 10);
        expect(second.run.attempts).toBe(2);
        expect(second.actions[0]?.kind).toBe('turn');
    });

    it('gives up on a turn the chat never reported ended', () => {
        const first = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, failing(), 0);
        expect(stepAutopilot(pilot(), first.run, failing(), AUTOPILOT_TURN_STALE_MS - 1).actions).toEqual([]);
        expect(stepAutopilot(pilot(), first.run, failing(), AUTOPILOT_TURN_STALE_MS + 1).run.attempts).toBe(2);
    });

    it('resets the count when the checks go green', () => {
        const first = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, failing(), 0);
        const ok = stepAutopilot(pilot(), first.run, pr(), 10);
        expect(ok.run.attempts).toBe(0);
        expect(ok.run.turn).toBeUndefined();
    });

    it('leaves a failing check to you when fixChecks is off', () => {
        const p = pr({ ...failing(), autopilot: pilot({ fixChecks: false }) });
        expect(stepAutopilot(p.autopilot, NEW_AUTOPILOT_RUN, p, 0).actions).toEqual([]);
    });

    it('stops when the PR has no chat to work in', () => {
        const p = { ...failing() };
        delete (p as { chatId?: ChatId }).chatId;
        const step = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, p, 0);
        expect(step.run.stopped?.reason).toBe('no-chat');
        expect(step.actions[0]?.kind).toBe('your-move');
    });
});

describe('answerThreads', () => {
    it('takes up each new thread once, not its own', () => {
        const p = pr({ review: { state: 'changes-requested', reviewers: ['lint'], threads: [thread('a'), thread('b'), thread('mine', { author: forge }), thread('c', { state: 'resolved' })] } });
        const step = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, p, 0);
        expect(step.actions).toHaveLength(1);
        const a = step.actions[0]!;
        if (a.kind !== 'turn') throw new Error('expected a turn');
        expect(a.turn).toBe('threads');
        expect(a.text).toContain('[a] lint');
        expect(a.text).toContain('[b] lint');
        expect(a.text).not.toContain('[mine]');
        expect(step.run.answered).toEqual(['a', 'b']);
        expect(autopilotActivity(pilot(), step.run, p)).toBe('Answering 2 review threads');
        // Replied to: the turn is over, and the same threads are not taken up again.
        const replied = pr({ review: { state: 'changes-requested', reviewers: ['lint'], threads: [thread('a', { state: 'replying' }), thread('b', { state: 'resolved' })] } });
        const after = stepAutopilot(pilot(), step.run, replied, 10);
        expect(after.actions).toEqual([]);
        expect(after.run.turn).toBeUndefined();
        // A new one is.
        const more = pr({ review: { state: 'changes-requested', reviewers: ['lint'], threads: [thread('a', { state: 'replying' }), thread('d')] } });
        const next = stepAutopilot(pilot(), after.run, more, 20);
        expect(next.run.turn?.threads).toEqual(['d']);
        expect(next.run.answered).toEqual(['a', 'd']);
    });

    it('waits for running checks before taking up threads', () => {
        const threads = { state: 'none' as const, reviewers: [], threads: [thread('a')] };
        const p = pr({ ...running(), review: threads });
        expect(stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, p, 0).actions).toEqual([]);
        expect(stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, pr({ review: threads }), 1).actions[0]).toMatchObject({ turn: 'threads' });
    });

    it('leaves threads to you when answerThreads is off', () => {
        const p = pr({ autopilot: pilot({ answerThreads: false }), review: { state: 'none', reviewers: [], threads: [thread('a')] } });
        expect(stepAutopilot(p.autopilot, NEW_AUTOPILOT_RUN, p, 0).actions).toEqual([]);
    });
});

describe('rebase', () => {
    it('rebases once on conflicts, then stops if they stay', () => {
        const conflict = pr({ mergeable: false });
        const first = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, conflict, 0);
        const a = first.actions[0]!;
        if (a.kind !== 'turn') throw new Error('expected a turn');
        expect(a.turn).toBe('rebase');
        expect(a.text).toContain('Rebase it onto main');
        expect(autopilotActivity(pilot(), first.run, conflict)).toBe('Rebasing onto main');
        const ended = autopilotTurnEnded(first.run, 100);
        expect(stepAutopilot(pilot(), ended, conflict, 200).actions).toEqual([]);
        const stuck = stepAutopilot(pilot(), ended, conflict, 100 + AUTOPILOT_SETTLE_MS);
        expect(stuck.run.stopped?.reason).toBe('conflicts');
        expect(stuck.actions[0]?.kind).toBe('your-move');
    });

    it('a rebase that cleared the conflicts is forgotten, so the next conflict gets one too', () => {
        const first = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, pr({ mergeable: false }), 0);
        const clear = stepAutopilot(pilot(), first.run, pr(), 10);
        expect(clear.run.rebased).toBeUndefined();
        expect(stepAutopilot(pilot(), clear.run, pr({ mergeable: false }), 20).actions[0]).toMatchObject({ kind: 'turn', turn: 'rebase' });
    });

    it('leaves conflicts to you when rebase is off', () => {
        const p = pr({ mergeable: false, autopilot: pilot({ rebase: false }) });
        expect(stepAutopilot(p.autopilot, NEW_AUTOPILOT_RUN, p, 0).actions).toEqual([]);
    });
});

describe('mergeWhenGreen', () => {
    it('merges green and approved through ask on merge, once per green run', () => {
        const step = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, green(), 0);
        expect(step.actions).toEqual([{ kind: 'merge', agentId: forge, rule: ASK_ON_MERGE }]);
        expect(ASK_ON_MERGE.outcome).toBe('ask');
        expect(autopilotActivity(pilot(), step.run, green())).toBe('Asking to merge');
        expect(stepAutopilot(pilot(), step.run, green(), 10).actions).toEqual([]);
        // A blocker ends the green run; green again asks again.
        const blocked = stepAutopilot(pilot(), step.run, running(), 20);
        expect(blocked.run.mergeAsked).toBeUndefined();
        expect(stepAutopilot(pilot(), blocked.run, green(), 30).actions[0]?.kind).toBe('merge');
    });

    it('does not merge unapproved, or with the switch off', () => {
        expect(stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, pr(), 0).actions).toEqual([]);
        const off = pr({ ...green(), autopilot: pilot({ mergeWhenGreen: false }) });
        expect(stepAutopilot(off.autopilot, NEW_AUTOPILOT_RUN, off, 0).actions).toEqual([]);
    });

    it('a declined merge stops it', () => {
        const step = autopilotMergeAnswered(NEW_AUTOPILOT_RUN, green(), false, 5, 'approver said no');
        expect(step.run.stopped).toMatchObject({ reason: 'merge-declined' });
        expect(step.run.stopped?.detail).toContain('approver said no');
        expect(autopilotMergeAnswered(NEW_AUTOPILOT_RUN, green(), true, 5).run.stopped).toBeUndefined();
    });
});

describe('priority and gates', () => {
    it('one turn at a time: conflicts first, then checks, then threads', () => {
        const all = pr({ mergeable: false, checks: [check('size', 'failed')], review: { state: 'none', reviewers: [], threads: [thread('a')] } });
        expect(stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, all, 0).actions[0]).toMatchObject({ turn: 'rebase' });
        const noConflict = { ...all, mergeable: true };
        expect(stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, noConflict, 0).actions[0]).toMatchObject({ turn: 'fix' });
    });

    it('does nothing on a settled PR or without switches', () => {
        expect(stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, pr({ ...failing(), state: 'merged' }), 0).actions).toEqual([]);
        expect(stepAutopilot(undefined, NEW_AUTOPILOT_RUN, failing(), 0).actions).toEqual([]);
    });

    it('Take over and Stop autopilot end its turn and hold it; resume starts over', () => {
        const busy = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, failing(), 0).run;
        const taken = takeOverAutopilot(busy, 10, 'andy');
        expect(taken.turn).toBeUndefined();
        expect(taken.stopped).toMatchObject({ reason: 'taken-over', detail: 'Taken over by andy.' });
        expect(stepAutopilot(pilot(), taken, failing(), 20).actions).toEqual([]);
        const off = stopAutopilot(busy);
        expect(off.off).toBe(true);
        expect(stepAutopilot(pilot(), off, failing(), 20).actions).toEqual([]);
        expect(autopilotActivity(pilot(), off, failing())).toBe('Autopilot is off');
        expect(resumeAutopilot(off)).toEqual({ attempts: 0, answered: [] });
    });

    it('withAutopilotRun fills attempt and activity for the PR page', () => {
        const run = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, failing(), 0).run;
        expect(withAutopilotRun(failing(), run).autopilot).toMatchObject({ attempt: 1, activity: 'Fixing size · attempt 1 of 3' });
        const idle = withAutopilotRun(pr({ autopilot: pilot({ attempt: 2, activity: 'old' }) }), NEW_AUTOPILOT_RUN).autopilot!;
        expect(idle.attempt).toBeUndefined();
        expect(idle.activity).toBeUndefined();
    });
});

describe('driveAutopilot', () => {
    const fakePort = (merge: AutopilotPort['merge'] = async () => ({ merged: true })) => {
        const log: string[] = [];
        const port: AutopilotPort = {
            async startTurn(t) {
                log.push(`turn ${t.agentId} ${t.chatId} ${t.taskId}`);
            },
            merge: async (m) => {
                log.push(`merge ${m.rule.id}`);
                return merge(m);
            },
            async yourMove(e) {
                log.push(`your-move ${e.stop.reason}`);
            }
        };
        return { port, log };
    };

    it('starts the turn through the port', async () => {
        const { port, log } = fakePort();
        const run = await driveAutopilot(port, NEW_AUTOPILOT_RUN, failing(), 0);
        expect(log).toEqual([`turn ${forge} ${chat} ${task}`]);
        expect(run.attempts).toBe(1);
    });

    it('merges through ask on merge, and a declined merge is your move', async () => {
        const ok = fakePort();
        expect((await driveAutopilot(ok.port, NEW_AUTOPILOT_RUN, green(), 0)).stopped).toBeUndefined();
        expect(ok.log).toEqual(['merge ask-on-merge']);
        const no = fakePort(async () => ({ merged: false, reason: 'denied' }));
        const run = await driveAutopilot(no.port, NEW_AUTOPILOT_RUN, green(), 0);
        expect(run.stopped?.reason).toBe('merge-declined');
        expect(no.log).toEqual(['merge ask-on-merge', 'your-move merge-declined']);
    });

    it('a turn that cannot start stops it instead of looping', async () => {
        const port: AutopilotPort = {
            startTurn: async () => {
                throw new Error('chat gone');
            },
            merge: async () => ({ merged: true })
        };
        const run = await driveAutopilot(port, NEW_AUTOPILOT_RUN, failing(), 0);
        expect(run.stopped?.detail).toContain('chat gone');
        expect(run.turn).toBeUndefined();
    });

    it('a turn that cannot start takes nothing up: threads, attempt and rebase stay open', async () => {
        const port: AutopilotPort = {
            startTurn: async () => {
                throw new Error('chat gone');
            },
            merge: async () => ({ merged: true })
        };
        const withThread = pr({ review: { state: 'none', reviewers: [], threads: [thread('a')] } });
        const t = await driveAutopilot(port, NEW_AUTOPILOT_RUN, withThread, 0);
        expect(t.answered).toEqual([]);
        expect(stepAutopilot(pilot(), resumeAutopilot(t), withThread, 1).run.turn?.threads).toEqual(['a']);
        expect((await driveAutopilot(port, NEW_AUTOPILOT_RUN, failing(), 0)).attempts).toBe(0);
        expect((await driveAutopilot(port, NEW_AUTOPILOT_RUN, pr({ mergeable: false }), 0)).rebased).toBeUndefined();
    });

    it('no chat takes nothing up either', () => {
        const p = pr({ review: { state: 'none', reviewers: [], threads: [thread('a')] } });
        delete (p as { chatId?: ChatId }).chatId;
        const step = stepAutopilot(pilot(), NEW_AUTOPILOT_RUN, p, 0);
        expect(step.run.stopped?.reason).toBe('no-chat');
        expect(step.run.answered).toEqual([]);
    });

    it('tells you on give-up', async () => {
        const { port, log } = fakePort();
        const run = await driveAutopilot(port, { attempts: 3, answered: [] }, failing(), 0);
        expect(run.stopped?.reason).toBe('gave-up');
        expect(log).toEqual(['your-move gave-up']);
    });
});
