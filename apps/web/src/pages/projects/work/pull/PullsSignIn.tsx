/**
 * The Pulls actor's `needs-sign-in` (#915, over #840): the project's repo has no GitHub credential, so its pull
 * requests cannot be read. Shown as a call to action — add a GitHub connector to the project, or set the workspace's
 * GitHub token on the git feature — never as the poll's raw error.
 */
import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import type { PullsReadiness } from '@agentic/platform';
import { settingsHref } from '../../settings/tabs';
import { GIT_FEATURE_ID } from '../../features/git/model';
import { pluginHref } from '../../../plugins/model';

export type PullsSignInProps = Define.Prop<'projectId', string, true> & Define.Prop<'readiness', PullsReadiness | undefined>;

/** Nothing unless the view says `needs-sign-in`. */
export const PullsSignIn = component<PullsSignInProps>(({ props }) => () =>
    props.readiness === 'needs-sign-in'
        ? (
            <section data-pulls-sign-in="" role="status" aria-label="GitHub sign-in needed">
                <p data-panel-note="">
                    <strong>Sign in to GitHub to see this project's pull requests.</strong>{' '}
                    The project has no GitHub credential yet: add a GitHub connector to it, or set the workspace's GitHub token.
                </p>
                <p>
                    <Link to={settingsHref(props.projectId, 'connectors')} data-pulls-sign-in-connector="">Add a GitHub connector</Link>
                    {' · '}
                    <Link to={pluginHref(GIT_FEATURE_ID)} data-pulls-sign-in-token="">Set the workspace token</Link>
                </p>
            </section>
        )
        : null, { name: 'PullsSignIn' });
