/**
 * `node dist/main.js export|import …` — move a Cloudflare deployment to this
 * node (#994).
 *
 *     # 0. the node's <home>/.env gets the deployment's WORKSPACE_KEK (sealed
 *     #    secrets) and SESSION_SECRET (agent and machine tokens) first
 *     # 1. with the node stopped:
 *     AGENTIC_EXPORT_ORIGIN=https://agentic.example AGENTIC_EXPORT_SECRET=<SESSION_SECRET> \
 *     CF_ACCOUNT_ID=… CF_API_TOKEN=… CF_DO_NAMESPACE_ID=<ACTORS namespace id> \
 *       node dist/main.js export dump.ndjson      # records → dump.ndjson, chat files → <home>/files
 *     node dist/main.js import dump.ndjson        # dump.ndjson → <home>/agentic.db
 *
 * `export --no-files` skips the chat files; `export --files <dir>` writes them
 * to another `fsBucket` directory (copy it to `<home>/files` later).
 */
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { sqliteStorage } from '@sigx/actors-sqlite';
import { fsBucket } from '../fs-bucket';
import type { NodeHome } from '../home';
import { importDump } from './dump';
import { exportDeployment } from './pull';

export const IMPORT_COMMANDS = ['export', 'import'] as const;

const USAGE = 'usage: main.js export <dump.ndjson> [--no-files | --files <dir>]  |  main.js import <dump.ndjson>';

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`[export] ${name} is not set`);
    return value;
}

/** Run `export` or `import`; resolves to the process exit code. */
export async function runImportCli(argv: readonly string[], home: NodeHome, env: Readonly<Record<string, string | undefined>> = process.env, log: (message: string) => void = console.log): Promise<number> {
    const [command, dump, ...rest] = argv;
    if (!dump || (command !== 'export' && command !== 'import')) {
        log(USAGE);
        return 2;
    }
    if (command === 'import') {
        const storage = sqliteStorage({ path: home.database });
        try {
            const lines = createInterface({ input: createReadStream(dump, 'utf8'), crlfDelay: Infinity });
            const counts = await importDump(lines, storage);
            log(`[import] ${counts.records} records (${counts.logEntries} log entries) and ${counts.reminders} reminders into ${home.database}`);
        } finally {
            storage.close();
        }
        return 0;
    }
    const filesAt = rest.indexOf('--files');
    const filesDir = rest.includes('--no-files') ? undefined : filesAt >= 0 ? rest[filesAt + 1] : home.files;
    if (filesAt >= 0 && !filesDir) {
        log(USAGE);
        return 2;
    }
    const out = createWriteStream(dump, 'utf8');
    try {
        const counts = await exportDeployment({
            origin: required(env, 'AGENTIC_EXPORT_ORIGIN'),
            secret: required(env, 'AGENTIC_EXPORT_SECRET'),
            accountId: required(env, 'CF_ACCOUNT_ID'),
            apiToken: required(env, 'CF_API_TOKEN'),
            namespaceId: required(env, 'CF_DO_NAMESPACE_ID'),
            ...(filesDir ? { files: fsBucket(filesDir) } : {}),
            writeLine: async (line) => {
                if (!out.write(`${line}\n`)) await once(out, 'drain');
            },
            log
        });
        log(`[export] ${counts.lines} records from ${counts.objects} objects into ${dump}${filesDir ? `, ${counts.files} chat files into ${filesDir}` : ''}`);
    } finally {
        out.end();
        await finished(out);
    }
    return 0;
}
