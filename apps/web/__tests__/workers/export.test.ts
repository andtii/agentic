/**
 * The state export on the real `ActorHost` (#994): the Worker fans listed
 * object ids (as the Cloudflare REST listing names them — no `id.name`) out
 * to the objects, each answers its records from storage, and nothing
 * without `SESSION_SECRET` gets an answer.
 */
import { SELF, env } from 'cloudflare:test';
import type { ChatId, WorkspaceId } from '@agentic/core';
import { Chat, Workspace, workspaceKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { EXPORT_HEADER, EXPORT_PATH, type ExportLine } from '../../src/export';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const userId = 'gh_9940';
const workspaceId = userId as WorkspaceId;
const bindings = env as unknown as { ACTORS: DurableObjectNamespace };
const listedId = (type: string, key: string) => bindings.ACTORS.idFromName(durableObjectName({ type, key })).toString();
const exportIds = (ids: string[], secret: string | null = TEST_SESSION_SECRET) =>
    SELF.fetch(`https://agentic.test${EXPORT_PATH}`, { method: 'POST', headers: secret ? { [EXPORT_HEADER]: secret } : {}, body: JSON.stringify({ ids }) });

describe('worker: the state export (#994)', () => {
    it('exports the workspace and chat objects by their listed ids, and refuses without the secret', async () => {
        const cookie = await signIn(userId);
        const wsKey = workspaceKey(workspaceId);
        const ws = overHttp(Workspace, wsKey, cookie);
        const { chatId } = await ws.createChat({});
        const chatKey = `${workspaceId}:chat:${chatId as ChatId}`;
        await overHttp(Chat, chatKey, cookie).post('hello');

        expect((await exportIds([listedId('Workspace', wsKey)], null)).status).toBe(403);
        expect((await exportIds([listedId('Workspace', wsKey)], 'x'.repeat(TEST_SESSION_SECRET.length))).status).toBe(403);

        const res = await exportIds([listedId('Workspace', wsKey), listedId('Chat', chatKey)]);
        expect(res.status).toBe(200);
        const lines = (await res.text())
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as ExportLine);
        const workspace = lines.find((l) => l.type === 'Workspace' && l.key === wsKey);
        const chat = lines.find((l) => l.type === 'Chat' && l.key === chatKey);
        expect(workspace?.record?.state).toBeTruthy();
        expect(JSON.stringify(workspace!.record)).toContain(chatId);
        expect(JSON.stringify(chat?.record)).toContain('hello');
    });
});
