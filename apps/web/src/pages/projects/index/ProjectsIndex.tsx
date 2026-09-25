import { component } from 'sigx';
import { Projects } from '../../Projects';

/**
 * `/projects` — the projects index (#725 seam; #729 builds the cards, the Projects / Links tabs and the strips). Until
 * then it is today's list (`pages/Projects.tsx`, #333), topbar and all.
 */
export const ProjectsIndex = component(() => () => <Projects />, { name: 'ProjectsIndex' });
