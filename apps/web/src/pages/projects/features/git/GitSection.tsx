/**
 * The Git feature's views (#746; HANDOFF.md → "Project home", board ProjectHome): its **Code** card on the project
 * Overview — the default branch with its checks pill, three stats (open PRs, your move, failing), the branches no
 * pull request heads yet and the last merge, `Open →` — and its **Code** section at `/projects/:id/f/<git>`: the same
 * stats, the open pull requests (each linking to its work item, and to its session's Changes view when it has one)
 * and the branches without a PR. The numbers are `model.ts`; the reads are `data.ts`.
 */
import { component } from 'sigx';
import { Link } from '@sigx/router';
import { Icon, StatusPill } from '@agentic/ui';
import { Age } from '../../../../components/Age';
import { changesHref } from '../../../session/files';
import type { ProjectPageProps } from '../../layout/types';
import { useGitSummary } from './data';
import { CHECKS_PILL, gitSectionHref, pullHref, taskItemHref, type GitOpenPull, type GitSummary } from './model';

const branchLine = (s: GitSummary) => {
    const pill = CHECKS_PILL[s.checks];
    return (
        <div data-git-branch-line="">
            <Icon name="branch" size={14} />
            <span data-git-branch="">{s.branch}</span>
            <span data-git-checks={s.checks}><StatusPill status={s.checks} tone={pill.tone} label={pill.label} /></span>
        </div>
    );
};

const stats = (s: GitSummary) => (
    <div data-git-stats="">
        <div data-git-stat="open"><span data-git-stat-n="">{String(s.open.length)}</span><span data-git-stat-label="">open PRs</span></div>
        <div data-git-stat="your-move" data-hot={s.yourMove ? '' : undefined}><span data-git-stat-n="">{String(s.yourMove)}</span><span data-git-stat-label="">your move</span></div>
        <div data-git-stat="failing" data-hot={s.failing ? '' : undefined}><span data-git-stat-n="">{String(s.failing)}</span><span data-git-stat-label="">failing</span></div>
    </div>
);

/** The Code card in the Overview's right column. */
export const GitOverviewCard = component<ProjectPageProps>(({ props }) => () => {
    const s = useGitSummary(props.project.id)();
    const without = s.branchesWithoutPr;
    return (
        <section data-overview-card="git" data-git-card="" aria-label="Code">
            <header data-overview-card-head="">
                <Icon name="branch" size={15} />
                <h2 data-overview-card-title="">Code</h2>
                <span data-overview-feature-tag="">FEATURE</span>
                <span data-overview-card-aside=""><Link to={gitSectionHref(props.project.id)}>Open →</Link></span>
            </header>
            {branchLine(s)}
            {stats(s)}
            <div data-overview-kv="" data-git-without="">
                <span data-overview-k="">Branches without a PR</span>
                <span data-overview-v="" data-mono="">
                    {without.length ? `${without.length} · ${without.map((b) => b.name).join(', ')}` : 'none'}
                </span>
            </div>
            <div data-overview-kv="" data-git-last-merge="">
                <span data-overview-k="">Last merge</span>
                <span data-overview-v="" data-mono="">
                    {s.lastMerge ? <>{`#${s.lastMerge.number} · `}<Age at={s.lastMerge.at} /></> : 'none yet'}
                </span>
            </div>
        </section>
    );
}, { name: 'GitOverviewCard' });

const pullRow = (projectId: string, o: GitOpenPull) => {
    const pr = o.pr;
    return (
        <li data-git-pull={String(pr.number)} data-your-move={o.yourMove ? '' : undefined}>
            <span data-git-pull-number="">{`#${pr.number}`}</span>
            <span data-git-row-main="">
                <Link to={pullHref(projectId, pr.number)}>
                    <span data-git-row-title="">{pr.title}</span>
                    <span data-git-row-detail="">{o.nextStep}</span>
                </Link>
            </span>
            <span data-git-head="">{pr.head}</span>
            <span data-git-pull-checks="">
                {o.failing
                    ? <StatusPill status="failed" tone="failed" label={`${o.failing} FAILING`} />
                    : <span data-git-diff="">{`+${pr.additions} −${pr.deletions}`}</span>}
            </span>
            <span data-git-changes="">{pr.sessionId ? <Link to={changesHref(pr.sessionId)}>Changes</Link> : null}</span>
            <Age at={pr.openedAt} />
        </li>
    );
};

/** The Code section: stats, open pull requests, branches without a PR. */
export const GitSection = component<ProjectPageProps>(({ props }) => () => {
    const id = props.project.id;
    const s = useGitSummary(id)();
    return (
        <section aria-label="Code" data-feature-section="" data-git-section="">
            {branchLine(s)}
            {stats(s)}
            <section data-git-block="pulls" aria-label="Open pull requests">
                <h2 data-git-block-title="">Open pull requests</h2>
                {s.open.length
                    ? <ul data-git-rows="">{s.open.map((o) => pullRow(id, o))}</ul>
                    : <p data-git-empty="">No open pull requests.</p>}
            </section>
            <section data-git-block="branches" aria-label="Branches without a PR">
                <h2 data-git-block-title="">Branches without a PR</h2>
                {s.branchesWithoutPr.length
                    ? (
                        <ul data-git-rows="">
                            {s.branchesWithoutPr.map((b) => (
                                <li data-git-branch-row={b.name}>
                                    <Icon name="branch" size={14} />
                                    <span data-git-head="">{b.name}</span>
                                    <span data-git-row-main=""><Link to={taskItemHref(id, b.taskId)}><span data-git-row-title="">{b.title}</span></Link></span>
                                </li>
                            ))}
                        </ul>
                    )
                    : <p data-git-empty="">Every branch has a pull request.</p>}
            </section>
            {s.lastMerge
                ? <p data-git-last-merge="">Last merge <Link to={pullHref(id, s.lastMerge.number)}>{`#${s.lastMerge.number}`}</Link> · <Age at={s.lastMerge.at} /></p>
                : null}
        </section>
    );
}, { name: 'GitSection' });
