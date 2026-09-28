// The agentic node inside the desktop app (#991). The `agentic-node` sidecar (sea-main.cjs) loads this
// file from the app's resources, and it runs the node's own CLI, `apps/node/dist/main.js`, with the
// arguments the app passes (`start --no-open`).
//
// Stopping: the app closes this process's stdin when it quits, and when it dies. That end is turned into
// the node's own SIGTERM shutdown (apps/node/src/main.ts): the daemon stops, the host drains, the
// database closes. A real SIGTERM is not an option on Windows, where it kills without a handler.
'use strict';

const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

/** How long a stop waits for the node to finish starting (its handler is installed once it listens). */
const START_WAIT_MS = 60_000;

let stopping = false;
function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = Date.now() + START_WAIT_MS;
    const tick = () => {
        if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM');
        else if (Date.now() > deadline) process.exit(0);
        else setTimeout(tick, 100);
    };
    tick();
}

// Once the app is gone its pipes are too: a write must not throw EPIPE in the middle of the drain.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
process.stdin.resume();

import(pathToFileURL(join(__dirname, 'apps', 'node', 'dist', 'main.js')).href).catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
});
