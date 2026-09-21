import { defineLibConfig } from '@sigx/vite/lib';
import { fileURLToPath } from 'node:url';
import type { ConfigEnv, Plugin, UserConfig } from 'vite';
import { stampFor } from './scripts/lib/stamp.mjs';

const base = defineLibConfig({
    entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
    external: [/@sigx\/.*/, /@agentic\/.*/, /^node:/, 'ws'],
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => {
    const config = base(env);
    // The build stamp (scripts/lib/stamp.mjs): baked into src/version.ts and written to dist/build.json,
    // which scripts/package.mjs reads to name the zip.
    const stamp = stampFor(fileURLToPath(new URL('.', import.meta.url)));
    const buildJson: Plugin = {
        name: 'agentic-daemon-build-json',
        generateBundle() {
            this.emitFile({ type: 'asset', fileName: 'build.json', source: `${JSON.stringify({ version: stamp.version, commit: stamp.commit, channel: stamp.channel }, null, 2)}\n` });
        }
    };
    return {
        ...config,
        define: {
            ...config.define,
            __DAEMON_VERSION__: JSON.stringify(stamp.version),
            __DAEMON_COMMIT__: JSON.stringify(stamp.commit),
            __DAEMON_CHANNEL__: JSON.stringify(stamp.channel)
        },
        plugins: [...(config.plugins ?? []), buildJson]
    };
};
