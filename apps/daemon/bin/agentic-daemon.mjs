#!/usr/bin/env node
// agentic-daemon pair | run | doctor — see apps/daemon/README.md.
import { main } from '../dist/cli.js';

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (error) => {
        process.stderr.write(`agentic-daemon: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
);
