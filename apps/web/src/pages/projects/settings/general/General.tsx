import { component } from 'sigx';
import { EditProject } from '../../../Projects';
import type { ProjectPageProps } from '../../layout/types';

/**
 * Settings › General (#725 seam; #733 builds the General, Members, Folders and Connectors tabs). Until then it is
 * today's whole project form (`pages/Projects.tsx`, #333), which reads the route's `:id` itself.
 */
export const ProjectGeneral = component<ProjectPageProps>(() => () => <EditProject />, { name: 'ProjectGeneral' });
