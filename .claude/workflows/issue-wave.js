export const meta = {
    name: 'issue-wave',
    description: 'Take a wave of andtii/agentic sub-issues in parallel: one agent per issue runs the take-issue skill (claim, worktree, pnpm check, local review, one push, auto-merge)',
    whenToUse: 'Run a wave of a tracking issue: args = [issue numbers] or { issues: [...], rounds?: 3 }. Issues whose Depends-on is still open are retried in a later round once the rest merge.',
    phases: [{ title: 'Take', detail: 'one agent per issue, each in its own pnpm wt worktree' }]
}

const input = Array.isArray(args) ? { issues: args } : args || {}
const issues = (input.issues || []).map((n) => Number(String(n).replace('#', ''))).filter((n) => n > 0)
const rounds = input.rounds || 3
if (!issues.length) throw new Error('issue-wave needs args: [issue numbers] or { issues: [...] }')

const RESULT = {
    type: 'object',
    properties: {
        issue: { type: 'number' },
        status: { type: 'string', enum: ['merged', 'auto-merge-armed', 'waiting-on-dependency', 'claimed-by-other', 'main-red', 'failed'] },
        pr: { type: 'string', description: 'PR URL, or empty' },
        dependsOnOpen: { type: 'array', items: { type: 'number' }, description: 'open Depends-on issues, when waiting' },
        followUps: { type: 'array', items: { type: 'string' }, description: 'follow-up issues filed' },
        notes: { type: 'string', description: 'what the next wave should know, or why it failed' }
    },
    required: ['issue', 'status', 'pr', 'notes']
}

const prompt = (n) => `Take GitHub issue #${n} of andtii/agentic end to end with the \`take-issue\` skill (.claude/skills/take-issue/SKILL.md) — invoke it via the Skill tool with args "#${n}".

- The primary checkout is C:\\Dev\\agentic\\main; create your own worktree with \`pnpm wt new ${n}-<short-slug>\` and work only there. Other agents are working on sibling issues in parallel in their own worktrees: never touch paths outside your issue's Owner paths.
- If a Depends-on issue is still open, do not start: return status "waiting-on-dependency" with dependsOnOpen. If someone else already claimed it, return "claimed-by-other". If a main-red issue is open, return "main-red".
- Finish with auto-merge armed (or merged). Do not wait more than ~15 minutes for CI after arming auto-merge; return "auto-merge-armed" with the PR URL.
Return the structured result.`

let pending = issues
const done = []
for (let round = 1; round <= rounds && pending.length; round++) {
    phase('Take')
    log(`round ${round}: ${pending.map((n) => '#' + n).join(' ')}`)
    const results = await pipeline(pending, (n) => agent(prompt(n), { label: `#${n}`, phase: 'Take', schema: RESULT, agentType: 'general-purpose' }))
    const got = results.map((r, i) => r || { issue: pending[i], status: 'failed', pr: '', notes: 'agent died or was skipped' })
    const settled = got.filter((r) => r.status !== 'waiting-on-dependency')
    done.push(...settled)
    const waiting = got.filter((r) => r.status === 'waiting-on-dependency')
    // Retry only when something merged this round — otherwise nothing can have unblocked.
    const progressed = settled.some((r) => r.status === 'merged' || r.status === 'auto-merge-armed')
    pending = progressed ? waiting.map((r) => r.issue) : []
    if (waiting.length && !progressed) {
        log(`no progress this round; still waiting: ${waiting.map((r) => '#' + r.issue).join(' ')}`)
        done.push(...waiting)
    }
    if (got.some((r) => r.status === 'main-red')) {
        log('main is red — stopping the wave; fix main first')
        done.push(...pending.map((n) => ({ issue: n, status: 'main-red', pr: '', notes: 'not started: main is red' })))
        pending = []
    }
}
if (pending.length) {
    log(`out of rounds; still waiting: ${pending.map((n) => '#' + n).join(' ')}`)
    done.push(...pending.map((n) => ({ issue: n, status: 'waiting-on-dependency', pr: '', notes: `not taken within ${rounds} rounds` })))
}
return done
