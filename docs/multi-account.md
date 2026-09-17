# Multi-account environments (Claude Code)

How three accounts on one machine are kept apart, what proves it, and what is
verified on which OS. Requirements EXE-04 (multiple accounts), EXE-05 (starting
work in one environment never changes another's authentication), EXE-07
(validated per runtime, incompatible configurations reported); acceptance AC-02.
Design context: `docs/architecture.md` §5b.

## The mechanism

One **environment** = one account = one Claude Code config dir.

- `environments.json` on the machine gives each environment a `profileDir`.
  The daemon's Claude Code driver (`@agentic/runtimes/claude-code`) runs one
  `claudeCode()` agent per environment with `CLAUDE_CONFIG_DIR = profileDir`,
  `settingSources: []`, and a child environment from which the daemon's own
  `CLAUDE_CONFIG_DIR` and every `ANTHROPIC_*` variable are removed. A child
  process can therefore only ever see its own profile: the CLI reads
  `<profileDir>/.credentials.json` (OAuth tokens) and `<profileDir>/.claude.json`
  (the signed-in account) and nothing else.
- Sessions of an environment are confined to its `cwdRoots`; a `cwd` outside
  them is refused before anything is spawned.
- The platform never sees a config dir. It selects an environment by id
  (a task's `environmentId`, else the agent's default) and the Routing actor
  binds a route to that environment once; it is never switched (EXE-12).

```json
{ "environments": [
  { "id": "env_work",     "name": "Work",     "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-work",     "cwdRoots": ["C:/src/work"],        "concurrency": 2, "accountLabel": "me@work.example" },
  { "id": "env_personal", "name": "Personal", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-personal", "cwdRoots": ["C:/src/personal"],    "concurrency": 1 },
  { "id": "env_client",   "name": "Client",   "runtime": "claude-code", "profileDir": "D:/clients/acme/.claude",      "cwdRoots": ["D:/clients/acme/repo"], "concurrency": 1 }
] }
```

Sign each profile in once, by hand, with the CLI pointed at that dir:

```powershell
$env:CLAUDE_CONFIG_DIR = "C:/Users/me/.claude-work";     claude /login
$env:CLAUDE_CONFIG_DIR = "C:/Users/me/.claude-personal"; claude /login
$env:CLAUDE_CONFIG_DIR = "D:/clients/acme/.claude";      claude /login
```

## What `doctor` checks and where the verdict shows

The driver's `doctor(envs)` (`claudeCodeDoctor`) reports, with the codes in
`CLAUDE_CODE_DOCTOR_CODES`:

| code | level | meaning |
|---|---|---|
| `shared-config-dir` | error | two environments resolve to one config dir (paths compared normalised: separators, `..`, trailing slash, case-folded on Windows) — one account, one set of settings. Never tolerated: `doctor.ok` is false. |
| `default-config-dir` | warn | no `profileDir`; the environment shares the default `~/.claude` with Claude Code run by hand. Two such environments are a `shared-config-dir` error. |
| `auth-ok` / `auth-missing` / `auth-expired` / `auth-unknown` | info / warn | the profile's sign-in state from `.credentials.json`, with the account e-mail from `.claude.json` when present. |

The verdict reaches the platform without anyone running a command:

1. `agentic-daemon doctor` prints the findings (plus pairing, drivers, working roots).
2. The daemon runs every driver's `doctor` at start and on each environment
   change and puts a per-environment verdict on the descriptor it sends in
   `hello` / `env` (`EnvironmentDescriptor.doctor = { ok, findings, checkedAt }`,
   derived with `environmentVerdict`). A driver whose checks throw gives each of
   its environments an error verdict `driver-doctor-failed`.
3. The Machine actor stores the descriptors, so `Machine.doctor(environmentId?)`
   returns `MachineDoctorView { ok, unverified, environments: [{ environmentId,
   account, isolation, verdict? }] }` — `ok` only when every environment has a
   verdict and none is an error. This is what the Machines page (#90) shows and
   what `environments.doctor` on the MCP surface (#50) returns.

## What is verified, and how

Automated, offline, in CI:

- `packages/runtimes/__tests__/claude-code/isolation.test.ts` — three profiles,
  one driver: three distinct agents and config dirs; six sessions in mixed order,
  every child environment carries its own `CLAUDE_CONFIG_DIR`, no `ANTHROPIC_*`
  variable and no other profile's dir, and all children are **equal except for
  that one variable**; a session in profile B changes nothing about profile A
  (same agent, same config dir, identical child env before and after); a `cwd`
  from another profile's roots is refused; `doctor()` passes three dirs and names
  the accounts, refuses two profiles on one dir with `shared-config-dir` (whatever
  the spelling of the path) and the per-environment verdict fails exactly those
  two.
- `packages/platform/__tests__/routing/routing.test.ts`, "multi-account
  environments on one machine" — AC-02 as a mock: one machine reports three
  environments with three identities; three tasks each pick one; every
  `session.open` the daemon receives names exactly the chosen environment; after
  the runs the machine's accounts and verdicts are byte-for-byte what they were
  before; `Machine.doctor()` is `ok`. A second run shows two environments on one
  config dir reported `shared-config-dir` and never `ok`.
- `apps/daemon/__tests__/daemon.test.ts` — `hello` carries the verdicts, a
  throwing driver yields `driver-doctor-failed`.
- `packages/platform/__tests__/machine/actor.test.ts` — `Machine.doctor()`
  shape, `unverified`, `env` updates, 404 / 403.

**Windows** is the validated platform: the CLI keeps credentials in
`<config dir>/.credentials.json`, so auth status and identity are read from the
profile without starting the CLI, and `CLAUDE_CONFIG_DIR` is honoured by the
CLI for both files. The daemon runs as a per-user scheduled task, so every
profile dir belongs to the user who signed in. **Linux** uses the same files and
is expected to behave the same, but has not been run by hand.

**Not verified: macOS.** There the CLI stores OAuth credentials in the Keychain,
keyed by the CLI, and it is not established whether two config dirs get two
Keychain entries or share one. `inspect` reports `authStatus: 'unknown'` on
`darwin` on purpose; do not present a macOS machine's environments as isolated
until this is checked (see the checklist).

## Manual checklist for the real driver (AC-02)

Record the run in the PR or issue that needs it. One machine, three profiles as
above, all three signed in as different accounts.

1. `agentic-daemon doctor` → three `auth-ok` findings naming three different
   e-mails, no `shared-config-dir`, exit 0.
2. Change `env_personal.profileDir` to `env_work`'s dir → `doctor` exits 1 with
   `shared-config-dir` naming both. Restore it.
3. `agentic-daemon run`; on the platform the machine is online and
   `Machine.doctor()` (Machines page, or the MCP `environments.doctor`) shows three
   verdicts `ok` with the three identities.
4. Run a task on `env_work` that prints who it is (`claude` answers `/status`, or
   ask the agent for its account e-mail). Then the same on `env_personal`, then
   `env_client`, then `env_work` again. Each answer is its own account; the
   fourth equals the first.
5. While a session runs on `env_work`, sign out of `env_personal` by hand
   (`CLAUDE_CONFIG_DIR=… claude /logout`). The running `env_work` session keeps
   working; after the daemon's next `env` (or restart) `env_personal` shows
   `auth-missing` and `env_work` still `auth-ok`.
6. Set `CLAUDE_CONFIG_DIR` and `ANTHROPIC_API_KEY` in the daemon's own shell
   before `run`. Every session still answers with its own environment's account —
   the daemon's variables never reach a child.
7. macOS only, when someone can: repeat 1–4 and note whether the CLI's Keychain
   entry is per config dir. Until then leave `authStatus` `unknown` on `darwin`.

## Out of scope here

- A Machines page — the UI track (#90) renders `Machine.get().environments`
  and `Machine.doctor()`.
- Refusing to route to an environment whose verdict is not `ok`: the verdict is
  shown, the choice stays the user's (a shared config dir is a configuration
  error to fix on the machine, not a reason to switch accounts silently).
