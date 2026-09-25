/**
 * The Pulls actor on the real `ActorHost` (#742): a task waits on the PR its agent reported, and the object's own
 * alarm — nothing else calling it — reads the merge and completes the task. The source is the pool's scripted fake
 * (`./pulls-source.ts`); alarms are advanced with `runDurableObjectAlarm`.
 */
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import type { AgentId, ChatId, MessageId, ProjectId, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { NO_PULL_SOURCES, TaskActor, definePullsActor, pullsKey, taskKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { overHttp, signIn } from './http';

const userId = 'gh_7420';
const workspaceId = userId as WorkspaceId;
/** Only its `type` ('pulls') matters to `overHttp`; the host runs the app's own definition. */
const Pulls = definePullsActor({ sources: NO_PULL_SOURCES });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALARM_MS = 60_000;
const TEST_MS = 120_000;

describe('worker: Pulls alarm → task completes on merge', () => {
    it('PRJ-10: the waiting task completes when its own alarm reads the merge', async () => {
        const cookie = await signIn(userId);
        const task = overHttp(TaskActor, taskKey(workspaceId, 'task_pr' as TaskId), cookie);
        await task.create({ objective: 'Open a PR', origin: { kind: 'user', chatId: 'chat_pr' as ChatId, messageId: 'msg_pr' as MessageId }, assignee: 'agent_pr' as AgentId, context: [], constraints: {} }, { owner: 'agent_pr' as AgentId });
        await task.start('user:gh_7420', 'sess_pr' as SessionId);

        const key = pullsKey(workspaceId, 'prj_pr' as ProjectId);
        const pulls = overHttp(Pulls, key, cookie);
        // Two reads of the open list see it open (watch, report), the third sees it merged.
        await pulls.watch({ provider: 'github', repo: 'fake/merge-after-2' });
        const reported = await pulls.report(1, { taskId: 'task_pr' as TaskId, chatId: 'chat_pr' as ChatId });
        expect(reported.pulls[0]).toMatchObject({ number: 1, state: 'open', taskId: 'task_pr' });
        expect(await task.explain()).toEqual({ kind: 'pull-request', number: 1, state: 'open' });

        // A branch link arms the next poll at once; from here on only the object's alarm runs it.
        await pulls.linkBranch('chat/other', { chatId: 'chat_other' as ChatId });
        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        const stub = namespace.get(namespace.idFromName(durableObjectName({ type: 'pulls', key })));
        const deadline = Date.now() + ALARM_MS;
        while ((await task.get()).status !== 'completed') {
            if (Date.now() > deadline) throw new Error(`the Pulls alarm never completed the task: ${JSON.stringify(await pulls.get())}`);
            await sleep(100);
            await runDurableObjectAlarm(stub);
        }
        const done = await task.get();
        expect(done.result?.text).toBe('Pull request #1 merged: One');
        expect((await pulls.get()).pulls[0]).toMatchObject({ number: 1, state: 'merged', taskId: 'task_pr' });
    }, TEST_MS);
});
