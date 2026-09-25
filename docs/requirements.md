# Unified Agent Platform — Product Requirements

- **Status:** Working draft
- **Version:** 0.1
- **Date:** 2026-09-17
- **Audience:** Product, design, and engineering
- **Scope:** Requirements only; implementation and service selection are deferred.

## 1. Purpose

Build a product for individual users to configure persistent AI agents and use them for coding, personal assistance, and other work through a unified interface.

Agents have their own identities, memory, skills, and permissions. They can communicate, delegate work, and participate in shared chats, while executing through different providers, accounts, and machines.

The platform must support installed agent runtimes and API-based assistants, with an extensible foundation for remote agents, connectors, workflows, and managed compute.

## 2. Requirement status

- **MUST** identifies a required product capability, not necessarily a first-release commitment.
- **SHOULD** identifies a recommended default or behavior that remains open to refinement.
- **MAY** identifies an optional capability.
- The first-release scope in section 16 is proposed.
- Open decisions are listed in section 18.

## 3. Agreed product direction

1. The product targets individual users with private workspaces.
2. Users configure individual agents with different responsibilities, skills, and powers.
3. Agents have persistent identities and their own memory.
4. Installed runtimes on user-controlled machines are a primary execution option.
5. Multiple machines and multiple accounts for the same runtime must be supported.
6. API-based assistants are also first-class agents.
7. Agents can communicate and delegate work to each other.
8. Chats can include the user and multiple agents.
9. Memory and learning require a plugin architecture with working defaults.
10. Agents should improve through outcomes and corrections, reducing repeated mistakes.
11. Web and mobile access are required.
12. Personal assistance, reminders, and background tasks are core use cases alongside coding.
13. Cloudflare is the preferred hosting target for the central service.
14. A2A interoperability and MCP integration are intended architectural directions.
15. Rich workflows, additional connectors, and provisioned VMs can be introduced in later phases.

## 4. Core concepts

| Concept | Definition |
| --- | --- |
| User workspace | A user's private collection of agents, chats, machines, environments, tasks, and settings. |
| Agent | A persistent identity with responsibilities, instructions, skills, permissions, memory, and execution configuration. |
| Role | An agent's purpose, such as developer, reviewer, researcher, or personal assistant. |
| Runtime adapter | An integration that connects the platform to an installed runtime, a platform-managed API agent, or a remote agent service. |
| Machine | A registered execution host, initially a user-controlled computer running a daemon. |
| Execution environment | A named configuration identifying execution location, runtime, account or authentication profile, and execution settings. |
| Chat | A persistent conversation containing the user and one or more agents. |
| Task | A tracked unit of work with an objective, owner, context, constraints, status, and result. |
| Execution session | A runtime interaction used by an agent to perform work; distinct from a chat and from the agent's identity. |
| Skill | Reusable instructions, procedures, or knowledge for performing a class of work. |
| Tool | A callable capability through which an agent reads information or performs an action. |
| Connector | An integration with an external service or data source. |
| Plugin | An installable extension providing one or more platform capabilities through defined interfaces. |
| Memory | Retained information associated with an agent or explicitly shared scope. |
| Workflow | A defined coordination of tasks, agents, triggers, and human decisions. |

A role does not determine an execution type. A developer can run through an API-based agent, and a personal assistant can delegate to an installed CLI runtime.

## 5. Users and access

- **USR-01 — Private workspaces:** The platform MUST isolate each user's agents, memories, credentials, chats, machines, and tasks from other users.
- **USR-02 — Multiple devices:** Users MUST be able to access the same workspace from multiple devices.
- **USR-03 — Web and mobile:** The product MUST support desktop and mobile use. Responsive web versus native mobile applications remains an open delivery decision.
- **USR-04 — Machine pairing:** Machines MUST register securely to the appropriate workspace and be revocable.
- **USR-05 — Initial audience:** Shared team workspaces and collaboration between different users are outside the proposed initial scope.

## 6. Agent identity and configuration

- **AGT-01 — Persistent identity:** An agent MUST retain its identity across chats, tasks, execution sessions, and supported environment changes.
- **AGT-02 — Configuration:** Users MUST be able to configure an agent's name, description, responsibilities, instructions, skills, tools, connectors, permissions, memory policy, approval policy, and execution settings.
- **AGT-03 — Independent agents:** Each agent MUST have its own configuration and private memory scope, with explicitly shared resources available where authorized.
- **AGT-04 — Skills and authority:** Skills MUST remain distinct from permissions. Adding a skill MUST NOT automatically grant credentials or authority.
- **AGT-05 — Execution defaults:** Agents SHOULD have a default environment with an explicit override available when starting work.
- **AGT-06 — Configuration history:** The platform MUST record the configuration used for a task or session. Durable instruction and skill changes MUST be versioned and reversible.
- **AGT-07 — Existing work:** Configuration changes SHOULD apply to new execution sessions by default; effects on active work must be explicit.
- **AGT-08 — Inactive persistence:** Agent identity and memory MUST persist without requiring a continuously running process.
- **AGT-09 — Capability transparency:** The platform MUST show which operations each integration supports and identify unsupported behavior.

Changing an environment preserves platform-managed identity and memory. It does not imply that provider-specific session state or hidden runtime state can migrate.

## 7. Execution types, machines, and accounts

| Execution type | Required integration behavior |
| --- | --- |
| Installed CLI/runtime | Drive an installed runtime through a machine daemon using the chosen environment and account. |
| Platform-managed API agent | Manage context, model calls, tool execution, continuation, and task completion through model APIs. |
| Remote agent | Exchange messages and tasks with an independently hosted agent through a supported adapter, including A2A. |

- **EXE-01 — Common model:** All supported execution types MUST integrate with the platform's agent, message, and task model, subject to declared capabilities.
- **EXE-02 — Multiple hosts:** A user MUST be able to register multiple machines and select where eligible work runs.
- **EXE-03 — Multiple environments:** A machine MUST support multiple named execution environments.
- **EXE-04 — Multiple accounts:** Environments MUST support different accounts for the same runtime, including accounts on the same machine.
- **EXE-05 — Account isolation:** Starting work in one environment MUST NOT silently change the authentication used by another environment or session.
- **EXE-06 — Account visibility:** The user MUST be able to identify the runtime, environment, machine or service, and account associated with execution.
- **EXE-07 — Runtime validation:** Multi-account support and isolation MUST be validated per runtime; incompatible configurations must be reported.
- **EXE-08 — Daemon responsibilities:** Daemons MUST report availability, runtime capabilities, authentication status, and execution activity; accept authorized work; and return results.
- **EXE-09 — Concurrency:** Multiple sessions MUST be supported where the environment allows them. Capacity constraints and queued work must be visible.
- **EXE-10 — Credential placement:** Local runtime credentials SHOULD remain on the execution machine. API and remote-service credentials require explicitly scoped storage and access.
- **EXE-11 — Offline behavior:** Tasks requiring unavailable environments MUST follow an explicit queue, failure, or authorized fallback policy.
- **EXE-12 — Environment switching:** The platform MUST NOT silently switch an executing task to a different account or environment.
- **EXE-13 — Portability:** Live migration of an active runtime session is not an initial requirement.

An environment is a logical boundary. Whether it uses a profile, process, operating-system account, container, or VM is an implementation decision based on the runtime's supported isolation mechanisms.

## 8. Chats and execution sessions

- **CHT-01 — Direct and group chats:** Users MUST be able to create persistent chats with one or more agents.
- **CHT-02 — Attribution:** Messages MUST identify their author; task and execution updates must identify the responsible agent.
- **CHT-03 — Addressing:** Users MUST be able to address individual agents directly or address the group.
- **CHT-04 — Membership:** Users MUST be able to add and remove agents and control access to earlier chat history.
- **CHT-05 — Individual identity:** Agents MUST retain their individual memory scopes and permissions inside group chats.
- **CHT-06 — Participation control:** The platform MUST define when agents respond. Mentions, assignments, and requests from other agents SHOULD be the initial activation mechanisms.
- **CHT-07 — Optional coordination:** A chat MAY assign a coordinator agent. A single global assistant is not required.
- **CHT-08 — Cross-device continuity:** Users MUST be able to leave a chat and return from another device without losing platform-recorded history or task status.
- **CHT-09 — Runtime controls:** Users MUST be able to send follow-ups, inspect progress, provide approvals, and request cancellation where supported. Limitations must be explicit.
- **CHT-10 — History and outputs:** Users MUST be able to revisit and search accessible history and inspect produced artifacts.
- **CHT-11 — Separation of state:** A chat MUST be able to coordinate multiple agents, tasks, and execution sessions without treating them as one provider conversation.

## 9. Agent communication and delegation

- **COL-01 — Communication:** Agents MUST be able to communicate across providers and execution environments.
- **COL-02 — Discovery:** Agents MUST be able to discover eligible collaborators and their declared responsibilities and capabilities.
- **COL-03 — Delegation:** Agents MUST be able to assign tasks to other agents without requiring the user to relay instructions.
- **COL-04 — Task contract:** Delegated work MUST carry an objective, originating agent or task, assigned agent, relevant context, constraints, and expected result.
- **COL-05 — Task lifecycle:** The platform MUST represent queued, active, waiting, completed, failed, and cancelled work, with sufficient detail to explain why a task is waiting.
- **COL-06 — Follow-up:** Agents MUST be able to request clarification, exchange progress, and return results.
- **COL-07 — Responsibility:** Delegating agents MUST be able to track delegated work and incorporate its result or report its failure.
- **COL-08 — Background work:** Collaboration MUST be possible outside an active user chat, with an accessible activity record.
- **COL-09 — Traceability:** Users MUST be able to inspect delegation relationships, ownership, status, and outcomes.
- **COL-10 — Authority:** Delegation MUST respect user-defined collaborator access and task authorization. It must not bypass approval requirements.
- **COL-11 — Limits:** The platform MUST support limits on delegation depth, agent turns, execution time, concurrency, and spending where measurable.
- **COL-12 — Stop behavior:** Users MUST be able to request that a task chain stop. The platform must track cancellation requests and identify work that could not be stopped.

The precise default collaborator policy remains open. Delegation is a required capability and should not require confirmation for every handoff already authorized by policy.

## 10. Memory

- **MEM-01 — Default implementation:** The platform MUST include a usable default memory implementation.
- **MEM-02 — Plugins:** Memory storage and retrieval MUST be replaceable or extensible through defined plugin interfaces.
- **MEM-03 — Agent ownership:** Platform-managed memory MUST be associated with agent identity rather than exclusively with a runtime session or machine.
- **MEM-04 — Scopes:** The platform MUST support private agent memory and explicitly shared knowledge with access controls.
- **MEM-05 — Lifecycle operations:** Memory interfaces MUST support storing, retrieving, updating, deleting, and exporting memories.
- **MEM-06 — Provenance:** Memories MUST support source attribution, timestamps, and a distinction between verified facts, user preferences, assumptions, and learned lessons.
- **MEM-07 — Relevant retrieval:** Agents MUST be able to retrieve relevant memories for a task without requiring their entire memory history in context.
- **MEM-08 — User control:** Users MUST be able to inspect, correct, delete, and export platform-managed memories.
- **MEM-09 — Migration:** Memory plugins MUST provide a defined export/import or migration path and identify fidelity limitations.
- **MEM-10 — Runtime boundary:** Integrations MUST identify how platform memory is supplied to the runtime and distinguish it from runtime-owned memory.
- **MEM-11 — Group privacy:** Joining a group chat MUST NOT automatically expose private agent memories to other participants.
- **MEM-12 — Default organization:** The default implementation SHOULD distinguish temporary working context, established facts and preferences, past-work records, and reusable lessons.

## 11. Learning and improvement

- **LRN-01 — Working default:** The platform MUST provide a default learning mechanism, with extension points separate from the memory backend.
- **LRN-02 — Evidence:** Learning MUST consider task outcomes, verification results, user corrections, and attributable feedback.
- **LRN-03 — Uncertainty:** Agent claims of success MUST remain distinguishable from independently verified success.
- **LRN-04 — Lessons:** Retained lessons MUST describe what was learned, supporting evidence, and the conditions under which the lesson applies.
- **LRN-05 — Application:** Relevant lessons MUST be retrievable before similar tasks or decisions.
- **LRN-06 — Revision:** Incorrect, obsolete, or conflicting lessons MUST be correctable or retired.
- **LRN-07 — Sharing:** Lessons MAY be shared between agents within explicit memory-sharing policies, preserving provenance.
- **LRN-08 — Controlled adaptation:** Learning MUST NOT silently expand permissions. Durable changes to skills or instructions must be versioned and reversible.
- **LRN-09 — Evaluation:** The product SHOULD measure repeated mistakes, recurring user corrections, and task outcomes to assess improvement.

The initial meaning of learning is improved retained knowledge, context, and procedures. Model training or fine-tuning is not required. The objective is to reduce repeated mistakes, not promise error-free behavior.

## 12. Personal assistance, schedules, and notifications

- **AST-01 — Personal use:** Personal assistance MUST be supported alongside coding through the common agent model.
- **AST-02 — Scheduling:** Users MUST be able to create reminders, recurring tasks, and scheduled agent work.
- **AST-03 — Independent scheduling:** Scheduling MUST operate without an open browser or active chat.
- **AST-04 — Reminders:** Simple reminders MUST be deliverable without requiring a user's coding machine to be online.
- **AST-05 — Dependent tasks:** Scheduled tasks requiring a particular environment MUST follow its offline policy.
- **AST-06 — Notifications:** Users MUST receive configured notifications for reminders, completed work, failures, and requests for input or approval.
- **AST-07 — Time handling:** Scheduling MUST define time-zone and daylight-saving behavior.
- **AST-08 — Event triggers:** The extension model MUST allow external events to initiate authorized tasks.
- **AST-09 — External services:** Personal-service access MUST use explicitly configured connectors and permissions.

## 13. Plugins and interoperability

- **PLG-01 — Extension points:** The architecture MUST define extension interfaces for runtimes and model providers, execution environments, tools and connectors, memory, learning, communication, triggers, notifications, and future workflow steps.
- **PLG-02 — Declarations:** Plugins MUST declare their identity, version, capabilities, configuration needs, permissions, and compatibility.
- **PLG-03 — Lifecycle:** Users MUST be able to configure, enable, disable, and remove supported plugins, with dependencies and affected capabilities visible.
- **PLG-04 — No implicit authority:** Installing a plugin MUST NOT automatically grant access to every secret, machine, or resource.
- **PLG-05 — Defaults:** Core functionality MUST work with provided defaults; users should not need to assemble a plugin stack before their first session.
- **PLG-06 — A2A:** The platform MUST support A2A interoperability for agent discovery and message/task exchange through adapters. Installed runtimes are not assumed to support A2A natively.
- **PLG-07 — MCP:** The platform MUST support MCP as an integration mechanism for tools and context, alongside other connector implementations.
- **PLG-08 — Platform responsibilities:** A2A and MCP MUST coexist with the platform's own chat, memory, scheduling, permission, and task-coordination requirements.
- **PLG-09 — Compatibility limits:** Adapters MUST declare unsupported operations and any translation limitations rather than silently implying feature parity.

Protocol versions and the plugin packaging and distribution model will be selected during implementation planning.

## 14. Reliability, permissions, and operational visibility

- **OPS-01 — Boundaries:** The platform MUST enforce workspace, memory, credential, and execution-resource boundaries.
- **OPS-02 — Approval policies:** Users MUST be able to configure actions that require approval and respond from supported clients.
- **OPS-03 — History:** Consequential actions, approvals, delegations, environment choices, and task transitions MUST be recorded for user inspection.
- **OPS-04 — Failure distinction:** The UI MUST distinguish client disconnection, daemon disconnection, unavailable authentication, runtime failure, and task failure.
- **OPS-05 — Recovery:** Reconnection and restart behavior MUST preserve durable task state and identify interrupted or uncertain work.
- **OPS-06 — Safe retries:** Delivery and retry mechanisms MUST prevent duplicate execution where possible and surface uncertain external outcomes before replaying actions.
- **OPS-07 — Consumption:** The platform MUST show available usage and cost information, identifying estimates and unavailable provider data.
- **OPS-08 — Budgets:** Execution and delegation MUST respect configured limits.
- **OPS-09 — Hosting:** The central service SHOULD target Cloudflare. Specific services, storage choices, and deployment topology remain open.
- **OPS-10 — Retention:** Data retention and deletion behavior MUST be explicit, including plugin-managed data and copies supplied to external runtimes.

Performance targets, availability objectives, backup policies, and recovery targets remain to be quantified.

## 15. Future capabilities and boundaries

The design MUST allow these capabilities without assuming they are all part of the first release:

- Rich connectors for personal and development services.
- Workflows with dependencies, branching, schedules, and human decisions.
- Provisioned VMs or other managed execution environments.
- Additional runtime, model, memory, learning, and communication plugins.
- Broader remote-agent interoperability.

The following are not first-release commitments:

- Shared team workspaces or cross-user agent collaboration.
- Automatic live migration of provider sessions.
- Automatic switching between accounts or machines.
- A public plugin marketplace.
- Model training or fine-tuning.
- Complete behavioral equivalence across runtimes.

## 16. Proposed first release

This scope is a recommendation requiring prioritization:

1. A private user workspace accessible through desktop and mobile web.
2. Machine pairing and named environments, including multiple accounts for one supported installed runtime.
3. One installed-runtime adapter and one platform-managed API agent implementation.
4. Agent creation with instructions, skills, permissions, and execution defaults.
5. Direct chats and group chats containing both execution types.
6. Structured delegation with task status, results, approvals, and stop controls.
7. Default private agent memory, explicit shared knowledge, and basic learning from corrections and verified outcomes.
8. Basic reminders, scheduling, and notifications.
9. Foundational plugin interfaces and a scoped A2A/MCP compatibility target.

Additional installed runtimes should follow the same adapter interface. VM provisioning, rich workflows, and a broad connector catalog can follow later.

## 17. Acceptance scenarios

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| AC-01 | A user registers two machines. | Both appear with independently reported environments and availability. |
| AC-02 | One machine has three accounts for the same supported runtime. | The user can choose each environment; execution does not change another environment's authentication. |
| AC-05 | The assistant delegates a task to the CLI agent. | The task has an owner, objective, traceable origin, status, and returned result. |
| AC-06 | The user disconnects and returns on mobile. | Chat history and platform-recorded task status remain available. |
| AC-07 | A selected machine is offline. | The platform follows the configured policy and does not silently change accounts or environments. |
| AC-08 | A reminder becomes due while all user machines are offline. | The central scheduling and notification path delivers the reminder. |
| AC-09 | A user corrects an agent and later starts a similar task. | The correction is retained with provenance and made available as relevant context. |
| AC-10 | An agent participates in a shared chat. | Other participants cannot access its private memory solely through chat membership. |
| AC-11 | A memory implementation is replaced. | Supported data can migrate through a defined path, with any limitations reported. |
| AC-12 | A delegated action requires approval. | Delegation preserves that requirement and exposes the approval request to the user. |
| AC-13 | A plugin is disabled. | Dependent capabilities are identified, and future use is prevented according to defined lifecycle behavior. |
| AC-14 | A compatible remote A2A agent is connected. | Its declared capabilities and supported task/message operations are available through the adapter. |
| AC-15 | An integration cannot resume or cancel a session. | The limitation is visible; the platform does not report a capability it lacks. |

## 18. Open decisions

1. **First integrations:** Which installed runtimes and API model providers are required at launch?
2. **Operating systems:** Which daemon platforms must be supported initially?
3. **Environment isolation:** Which supported isolation mechanisms are needed per runtime and account type?
4. **Collaboration policy:** Can an agent delegate to every eligible agent in the workspace by default, or only explicitly assigned collaborators?
5. **Shared resources:** What are the default policies for shared folders, projects, and knowledge?
6. **Learning policy:** Which memory updates are automatic, and which durable instruction or skill changes require review?
7. **API credentials and billing:** Will users provide their own credentials, use platform billing, or have both options?
8. **Mobile delivery:** Is responsive web sufficient initially, and which notification channels are required?
9. **Plugin model:** How are plugins packaged, distributed, isolated, and configured?
10. **Group activation:** What are the precise rules for agent turns, unsolicited contributions, and optional coordinators?
11. **First-release interoperability:** Which A2A and MCP versions and feature subsets will be validated?
12. **Operations:** What retention, availability, latency, backup, and recovery targets should apply?
13. **First-release scope:** Which proposed features are launch requirements versus immediate follow-up work?

## 19. Protocol references

These references inform interoperability requirements; they do not prescribe the internal implementation.

- [A2A protocol specification](https://a2a-protocol.org/latest/specification/)
- [MCP architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)

## 20. Projects

The projects redesign ([#722](https://github.com/andtii/agentic/issues/722)) turns a project into the home for everything done toward one goal: its chats, its work, its plan and the features switched on for it. The target is the handoff in [`docs/design/projects/`](design/projects/HANDOFF.md) ("Projects"); the decisions that close its open questions are in [`docs/decisions.md`](decisions.md) (2026-09-25). Each requirement names the sub-issues that implement it.

- **PRJ-01 — Project sub-menu:** Opening a project MUST expand the sidebar's `Projects` item into the project's own menu: a switcher (project square, name, a project picker), Overview, Chats, Work and Requests (Requests only with a project manager), one item per enabled feature that contributes a section, and the Settings items. Counts that need the user MUST use the Home `needs-you` badge, and crumbs MUST start `Projects › <project>`. _Issues: #725, #727, #728, #734._
- **PRJ-02 — Projects index:** `/projects` MUST list the projects as cards showing what needs the user (your move) and how many agents are on each, with an open-links strip and a strip for work outside any project. _Issues: #726, #729, #734._
- **PRJ-03 — Project overview:** `/projects/:id` MUST answer what needs the user here and what is going on: Your move, the most recent live chats, one card per enabled feature, then Schedules and People and places, then an Add a feature card. It MUST work for a project with no code. _Issues: #730._
- **PRJ-04 — Project chats:** A project's chats MUST be grouped by who acts next (Needs you, Agents working, Quiet, Archived), with a strip of the defaults a new chat inherits and a Review and move strip for chats outside any project. Moving a chat in or out of a project MUST call each enabled feature's chat-release hook first. The global `/chats` MUST group by project. _Issues: #731, #732._
- **PRJ-05 — Work:** A project MUST show one list of everything in flight as work items with a stage track, grouped by whose move it is (Your move, Agents on it, Waiting on CI or a reviewer, Done this week). The enabled features decide the stages, falling back to Ready, Do, Review, Done. Work items are derived from tasks, pull requests and plan items, not stored. _Issues: #724, #726, #738, #739._
- **PRJ-06 — Feature slots:** A project-feature manifest MUST be able to declare an optional `ui` block: a section, an overview card, work stages, chat ref prefixes, tool families that join sessions, and what the feature needs (a folder, a machine). _Issues: #724, #735, #737, #740, #746, #753._
- **PRJ-07 — Features page:** Settings › Features MUST list the enabled features with a switch and slot marks, a catalogue by category (Planning, Events, Knowledge, Code, Ops) that shows why a feature cannot be added yet (for example NEEDS A FOLDER), and a detail panel explaining each slot. Removing a feature MUST keep its data for 30 days. _Issues: #726, #735, #736._
- **PRJ-08 — Pull requests:** With Git on, a pull request MUST be a stage of its work item, with a page showing what is happening now, checks, review threads, autopilot, every merge blocker in one sentence, and linked items. Git MUST sit behind a provider-neutral adapter (GitHub first), and the UI MUST read only `checks`, `reviews`, `mergeable` and `autopilot` from it. _Issues: #724, #740, #741, #742, #744, #746._
- **PRJ-09 — Autopilot:** A pull request MAY run on autopilot: agents fix failing checks, answer review threads, rebase and merge when green, within a stated attempt limit, and the page MUST say who fixes what. _Issues: #724, #743, #744._
- **PRJ-10 — Pull request surfaces:** A pull request MUST appear as the same component and state in chat, on Home, in the task tree and in notifications. A task waiting on its pull request MUST complete on merge, and the user MUST be notified only when the next move becomes theirs or autopilot gives up. _Issues: #742, #745, #747._
- **PRJ-11 — Plan store:** Plan is a project feature. A project MAY hold several plans of phases and items; an item is carried out by a task (plan → item → task). Items MUST support assignment queues, claims with a lease (default 30 minutes, renewed on each plan call, returned to the top of the assignee's queue when it runs out), a working limit per agent per project (default 1), `after` dependencies (a blocked item cannot be claimed), touched paths that warn on overlap, typed refs (file lines pinned to a commit, PRs, commits, chat messages, doc sections, URLs, items) and a done-when checklist. Every plan change MUST go to History with its actor. _Issues: #748, #749, #750, #752, #753._
- **PRJ-12 — Plan tools:** Agents MUST work the plan through `plan_list`, `plan_next`, `plan_claim`, `plan_assign`, `plan_update`, `plan_ref`, `plan_add` and `plan_handoff`, with the platform enforcing leases, limits and dependencies, and one ref syntax shared by chats, items and notes. _Issues: #737, #748, #751._
- **PRJ-13 — Plan views:** A plan MUST be viewable as a list (phases, crew strip, item detail with ref hover cards), a board (a column per agent with its limit and queue, Not assigned and You; dragging assigns and a moved claimed item sends a handoff note) and a graph, selected by `?view=list|board|graph`, with a plan switcher. _Issues: #726, #754, #755, #756._
- **PRJ-14 — Project manager:** A project MAY have a project manager, the agent in `ProjectMembers.coordinator`; one agent MAY manage several projects. It owns the plan and assigns work. Settings › Project manager MUST set the agent, who may send requests, what it may do without asking, and a weekly summary on Home. High or urgent priority MUST always come to a person. _Issues: #724, #734, #757, #758, #760, #763._
- **PRJ-15 — Requests:** Work MUST be able to move between projects as requests handled by the receiving project's manager: a Requests inbox with state and origin, the manager's triage and proposed item, the reply that will be posted back, and Accept, Edit first, Ask for more and Decline. Requests between two projects of the same owner skip approval unless the target's policy says Ask me first. Agents send requests with `projects_request`; the manager uses `requests_list`, `requests_triage` and `requests_resolve`. _Issues: #757, #758, #759, #761._
- **PRJ-16 — Visiting project manager:** Another project's manager MUST be able to join a chat by `@` mention, marked as visiting with its project, with request and result cards that update in place and an Across projects card listing linked items. _Issues: #762._
- **PRJ-17 — Links across projects:** An item's `after` MUST be able to hold items in other projects, and `/projects/links` MUST show one lane per project with an open link, arrows from the item waited on to the waiting item, and a highlighted chain with who is on each step. _Issues: #764, #765._
- **PRJ-18 — Settings and new project:** A project's settings MUST cover General, Members (roles and working limits), Folders and Connectors, and a New project dialog MUST create one. The old projects page and its dead mocks MUST be removed once the redesign replaces them. _Issues: #733, #767._
- **PRJ-19 — Responsive:** Every project page MUST work at 400, 1024 and 1280 px without overflow, with end-to-end coverage of the main flows. _Issues: #766._
