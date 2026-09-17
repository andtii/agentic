// @vitest-environment node
import { decryptSecret, encryptSecret, generateWorkspaceKek, importWorkspaceKek } from '../../src/index';

describe('WORKSPACE_KEK (AES-GCM)', () => {
    it('encrypts a stored API key and decrypts it under the same key and slot', async () => {
        const kek = await importWorkspaceKek(generateWorkspaceKek());
        const sealed = await encryptSecret(kek, 'sk-ant-secret', 'ws_1:anthropic');
        expect(sealed).toMatch(/^kek1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
        expect(sealed).not.toContain('sk-ant');
        await expect(decryptSecret(kek, sealed, 'ws_1:anthropic')).resolves.toBe('sk-ant-secret');
        // Fresh IV every time: the same plaintext never seals the same way.
        expect(await encryptSecret(kek, 'sk-ant-secret', 'ws_1:anthropic')).not.toBe(sealed);
    });

    it('refuses the wrong key, the wrong slot, a tampered body, and a foreign shape', async () => {
        const kek = await importWorkspaceKek(generateWorkspaceKek());
        const other = await importWorkspaceKek(generateWorkspaceKek());
        const sealed = await encryptSecret(kek, 'value', 'slot-a');
        await expect(decryptSecret(other, sealed, 'slot-a')).rejects.toThrow(/failed to decrypt/);
        await expect(decryptSecret(kek, sealed, 'slot-b')).rejects.toThrow(/failed to decrypt/);
        await expect(decryptSecret(kek, sealed)).rejects.toThrow(/failed to decrypt/);
        const [v, iv, body] = sealed.split('.') as [string, string, string];
        await expect(decryptSecret(kek, `${v}.${iv}.${body.slice(0, -2)}AA`, 'slot-a')).rejects.toThrow(/failed to decrypt/);
        await expect(decryptSecret(kek, 'kek0.a.b', 'slot-a')).rejects.toThrow(/not a sealed secret/);
    });

    it('accepts base64 or base64url of 16 or 32 bytes only', async () => {
        await expect(importWorkspaceKek('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).resolves.toBeDefined();
        await expect(importWorkspaceKek('AAAAAAAAAAAAAAAAAAAAAA==')).resolves.toBeDefined();
        await expect(importWorkspaceKek('too-short')).rejects.toThrow(/16 or 32 bytes/);
    });
});
