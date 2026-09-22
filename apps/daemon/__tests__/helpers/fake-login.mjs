// A CLI's sign-in as the relay sees it (#484): prints what the real ones print (the #483 spike's captures) and ends
// the way they end. `--kind claude` waits for a code on stdin and accepts `--accept <code>`; `--kind codex` / `copilot`
// print a device code and exit 0 after `--after <ms>` (default 50); `--hang` never exits (for cancel / timeout).
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const kind = flag('kind', 'claude');
const accept = flag('accept', 'code-1');
const after = Number(flag('after', '50'));
const hang = args.includes('--hang');
const bad = args.includes('--bad');
const stay = () => setInterval(() => undefined, 1_000);

if (bad) {
    process.stderr.write('Error: the browser could not be opened and no code was given\n');
    process.exit(2);
}
if (kind === 'claude') {
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(`If the browser didn't open, visit: ${flag('url', `https://claude.example.test/oauth/authorize?code=true&client_id=fake&state=${Math.random().toString(36).slice(2)}`)}\n`);
    process.stdout.write('Paste code here if prompted > ');
    if (hang) stay();
    else {
        let buffer = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            buffer += chunk;
            const line = buffer.split('\n')[0];
            if (!buffer.includes('\n')) return;
            if (line.trim() === accept) {
                process.stdout.write('\nLogin successful. Press Enter to continue…\n');
                process.exit(0);
            }
            process.stderr.write('Login failed: Request failed with status code 400\n');
            process.exit(1);
        });
        process.stdin.on('end', () => {
            process.stderr.write('Login failed: no code was pasted\n');
            process.exit(1);
        });
    }
} else if (kind === 'codex') {
    process.stdout.write('\nWelcome to Codex [v\x1b[90m0.154.0\x1b[0m]\n\x1b[90mOpenAI\'s command-line coding agent\x1b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.example.test/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mRGM1-ZUVN0\x1b[0m\n\n\x1b[90mContinue only if you started this login in Codex.\x1b[0m\n');
    if (hang) stay();
    else setTimeout(() => process.exit(0), after);
} else {
    process.stdout.write('To authenticate, visit https://github.example.test/login/device and enter code 024D-01A7\nWaiting for authorization...\n');
    process.stderr.write('Failed to copy to clipboard. Please visit https://github.example.test/login/device and enter the code 024D-01A7 manually.\n');
    if (hang) stay();
    else setTimeout(() => process.exit(0), after);
}
