/**
 * What every page inside a project gets (#725): the project `ProjectLayout` loaded — mock or live — so a page never
 * reads the route's `:id` or loads the record itself.
 */
import type { ComponentFactory, Define } from 'sigx';
import type { ProjectRecord } from '@agentic/core';

export type ProjectPageProps = Define.Prop<'project', ProjectRecord, true>;

/** A page rendered inside the project layout. */
export type ProjectPage = ComponentFactory<ProjectPageProps, void, {}>;
