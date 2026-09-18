/**
 * Chat attachments on the real Worker (#207): `POST /files/chats/:chatId`
 * writes to the `ARTIFACTS` R2 bucket and registers the upload with the Chat
 * actor as the signed-in user; `GET /files/chats/:chatId/:fileId` streams it
 * back only when `Chat.fileAccess` says so, with the hardening headers.
 */
import { env, SELF } from 'cloudflare:test';
import { CHAT_FILE_MAX_BYTES, chatFileUri, type ChatFile, type ChatId, type WorkspaceId } from '@agentic/core';
import { Chat, Workspace, workspaceKey } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { chatFileKey } from '../../src/files/store';
import { overHttp, signIn } from './http';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_files';
const WS = userId as WorkspaceId;
const bucket = (env as unknown as { ARTIFACTS: R2Bucket }).ARTIFACTS;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function newChat(cookie: string): Promise<ChatId> {
    const { chatId } = await overHttp(Workspace, workspaceKey(WS), cookie).createChat({});
    return chatId as ChatId;
}

function upload(chatId: string, cookie: string | null, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/files/chats/${chatId}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'image/png', 'x-file-name': encodeURIComponent('screen shot.png'), ...(cookie ? { cookie } : {}), ...headers },
        body
    });
}

const download = (chatId: string, fileId: string, cookie: string | null): Promise<Response> => SELF.fetch(`${ORIGIN}/files/chats/${chatId}/${fileId}`, { headers: cookie ? { cookie } : {} });

describe('worker: chat file upload and download over R2 (#207)', () => {
    it('uploads, then GET as the uploader returns the bytes with the hardening headers', async () => {
        const cookie = await signIn(userId);
        const chatId = await newChat(cookie);
        const res = await upload(chatId, cookie, PNG);
        expect(res.status).toBe(201);
        const { file, uri } = (await res.json()) as { file: ChatFile; uri: string };
        expect(file).toMatchObject({ chatId, name: 'screen shot.png', mediaType: 'image/png', bytes: PNG.byteLength });
        expect(uri).toBe(chatFileUri(chatId, file.id));

        const object = await bucket.head(chatFileKey(WS, chatId, file.id));
        expect(object?.customMetadata).toMatchObject({ name: 'screen shot.png', mediaType: 'image/png', posted: '0' });

        const got = await download(chatId, file.id, cookie);
        expect(got.status).toBe(200);
        expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
        expect(got.headers.get('content-type')).toBe('image/png');
        expect(got.headers.get('x-content-type-options')).toBe('nosniff');
        expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
        expect(got.headers.get('cache-control')).toBe('private, max-age=3600');
        expect(got.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''screen%20shot.png");

        // Posting it marks the object, so the orphan sweep keeps it.
        await overHttp(Chat, chatKeyOf(WS, chatId), cookie).post([{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', url: uri }]);
        expect((await bucket.head(chatFileKey(WS, chatId, file.id)))?.customMetadata?.posted).toBe('1');
        expect((await download(chatId, file.id, cookie)).status).toBe(200);
    });

    it('answers 404 to a principal from another workspace, and 401 to nobody', async () => {
        const cookie = await signIn(userId);
        const chatId = await newChat(cookie);
        const { file } = (await (await upload(chatId, cookie, PNG)).json()) as { file: ChatFile };
        const stranger = await signIn('gh_files_other');
        const res = await download(chatId, file.id, stranger);
        expect(res.status).toBe(404);
        await res.body?.cancel();
        const anonymous = await download(chatId, file.id, null);
        expect(anonymous.status).toBe(401);
        await anonymous.body?.cancel();
    });

    it('refuses an oversize upload with 413 — by Content-Length and while streaming — and stores nothing', async () => {
        const cookie = await signIn(userId);
        const chatId = await newChat(cookie);
        const declared = await upload(chatId, cookie, new Uint8Array(16), { 'content-length': String(CHAT_FILE_MAX_BYTES + 1) });
        expect(declared.status).toBe(413);

        const chunk = new Uint8Array(1024 * 1024);
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent > CHAT_FILE_MAX_BYTES) return controller.close();
                sent += chunk.byteLength;
                controller.enqueue(chunk);
            }
        });
        const streamed = await upload(chatId, cookie, stream);
        expect(streamed.status).toBe(413);
        const listed = await bucket.list({ prefix: `files/${WS}/${chatId}/` });
        expect(listed.objects).toEqual([]);
    });

    it('requires a same-origin Origin and a type it accepts; SVG downloads as an attachment', async () => {
        const cookie = await signIn(userId);
        const chatId = await newChat(cookie);
        expect((await upload(chatId, cookie, PNG, { origin: 'https://evil.example' })).status).toBe(403);
        expect((await upload(chatId, cookie, PNG, { 'content-type': 'text/html' })).status).toBe(415);
        expect((await upload(chatId, cookie, PNG, { 'content-type': 'nonsense' })).status).toBe(415);

        const svg = await upload(chatId, cookie, '<svg xmlns="http://www.w3.org/2000/svg"/>', { 'content-type': 'image/svg+xml', 'x-file-name': encodeURIComponent('..\\..\\logo.svg') });
        expect(svg.status).toBe(201);
        const { file } = (await svg.json()) as { file: ChatFile };
        expect(file.name).toBe('logo.svg');
        const got = await download(chatId, file.id, cookie);
        expect(got.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''logo.svg");
        await got.body?.cancel();
    });
});
