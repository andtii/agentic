import { expectTypeOf } from 'vitest';
import type { AccountKey, AccountRef, AgentId, ChatEntry, ChatFile, ChatFileBody, ChatFilePart, ChatFileRead, ChatFileStore, ChatId, ChatRoster, DaemonFrame, EnvErrorCode, EnvironmentInput, EnvOp, ExecutionDefaults, FsErrorCode, FsOp, FsResult, MachineId, OpenSpec, PlatformFrame, PluginKind, Principal, ProjectId, Proposal, QuotaAccount, ReleaseAsset, RuntimeDriver, RuntimeOpenContext, SessionClosedCode, TaskContract, TaskOrigin, TaskStatus, WaitReason } from '../src/index';
import type { DAEMON_FRAME_TYPES, PLATFORM_FRAME_TYPES } from '../src/index';

// Every union is closed: exhaustiveness holds and the discriminants are literal.
type Discriminant<T, K extends keyof T> = T[K];

describe('contract type tests', () => {
    it('task status and wait reasons are closed unions', () => {
        expectTypeOf<TaskStatus>().toEqualTypeOf<'queued' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'>();
        expectTypeOf<Discriminant<WaitReason, 'kind'>>().toEqualTypeOf<'approval' | 'input' | 'environment-offline' | 'child' | 'capacity' | 'budget' | 'project-feature' | 'turn' | 'machine-offline'>();
        expectTypeOf<Discriminant<TaskOrigin, 'kind'>>().toEqualTypeOf<'user' | 'agent' | 'schedule' | 'trigger' | 'external'>();
    });
    it('chat entries and principals are discriminated', () => {
        expectTypeOf<Discriminant<ChatEntry, 't'>>().toEqualTypeOf<'msg' | 'member' | 'status' | 'coordinator' | 'rename'>();
        expectTypeOf<Extract<ChatEntry, { t: 'msg' }>['project']>().toEqualTypeOf<{ readonly id: ProjectId | null } | undefined>();
        expectTypeOf<TaskContract['projectId']>().toEqualTypeOf<ProjectId | undefined>();
        expectTypeOf<'project-feature'>().toMatchTypeOf<PluginKind>();
        expectTypeOf<Discriminant<Principal, 'kind'>>().toEqualTypeOf<'user' | 'machine' | 'agent' | 'external'>();
    });
    it('daemon frames are versioned and generic over the wire types', () => {
        type F = { readonly kind: 'event' };
        expectTypeOf<Extract<DaemonFrame<F>, { t: 'session.frame' }>['frame']>().toEqualTypeOf<F>();
        expectTypeOf<DaemonFrame['v']>().toEqualTypeOf<1>();
        expectTypeOf<Discriminant<PlatformFrame, 't'>>().toEqualTypeOf<'welcome' | 'session.open' | 'session.command' | 'session.close' | 'tool.result' | 'ping' | 'fs.request' | 'env.request' | 'history.request' | 'update.request' | 'update.cancel' | 'harness.request'>();
        expectTypeOf<Discriminant<DaemonFrame, 't'>>().toEqualTypeOf<(typeof DAEMON_FRAME_TYPES)[number]>();
        expectTypeOf<Discriminant<PlatformFrame, 't'>>().toEqualTypeOf<(typeof PLATFORM_FRAME_TYPES)[number]>();
        expectTypeOf<Extract<DaemonFrame, { t: 'session.closed' }>['code']>().toEqualTypeOf<SessionClosedCode | undefined>();
        expectTypeOf<Extract<PlatformFrame, { t: 'update.request' }>['target']>().toEqualTypeOf<ReleaseAsset | 'previous'>();
        expectTypeOf<Discriminant<Extract<PlatformFrame, { t: 'env.request' }>, 'op'>>().toEqualTypeOf<'put' | 'remove'>();
    });
    it('fs operations and results are closed unions', () => {
        expectTypeOf<Discriminant<FsOp, 'kind'>>().toEqualTypeOf<'list' | 'worktree' | 'locate'>();
        expectTypeOf<Discriminant<FsResult, 'kind'>>().toEqualTypeOf<'list' | 'worktree' | 'locate'>();
        expectTypeOf<Extract<FsOp, { kind: 'locate' }>['origin']>().toEqualTypeOf<string>();
        expectTypeOf<'outside-roots'>().toMatchTypeOf<FsErrorCode>();
    });
    it('env operations are a closed union and an environment input never names a profile directory', () => {
        expectTypeOf<Discriminant<EnvOp, 'op'>>().toEqualTypeOf<'put' | 'remove'>();
        expectTypeOf<'outside-allowed-roots'>().toMatchTypeOf<EnvErrorCode>();
        expectTypeOf<'profileDir'>().not.toMatchTypeOf<keyof EnvironmentInput>();
    });
    it('runtime drivers are generic over the session and policy types', () => {
        type S = { readonly id: string };
        type P = { readonly rules: readonly string[] };
        expectTypeOf<Awaited<ReturnType<RuntimeDriver<S, P>['open']>>['session']>().toEqualTypeOf<S>();
        expectTypeOf<Parameters<RuntimeDriver<S, P>['open']>[1]>().toEqualTypeOf<OpenSpec>();
        expectTypeOf<Parameters<RuntimeDriver<S, P>['open']>[2]>().toEqualTypeOf<RuntimeOpenContext<P>>();
        expectTypeOf<RuntimeOpenContext['callTool']>().returns.toEqualTypeOf<Promise<unknown>>();
    });
    it('chat files are referenced, never inlined, and the store is async', () => {
        expectTypeOf<ChatFilePart['url']>().toEqualTypeOf<string>();
        expectTypeOf<Discriminant<ChatFilePart, 'type'>>().toEqualTypeOf<'image' | 'file'>();
        expectTypeOf<ReturnType<ChatFileStore['get']>>().toEqualTypeOf<Promise<ChatFileBody | null>>();
        expectTypeOf<ChatFileRead['file']>().toEqualTypeOf<ChatFile>();
    });
    it('ids do not mix', () => {
        expectTypeOf<AgentId>().not.toEqualTypeOf<ChatId>();
        // @ts-expect-error a ChatId is not an AgentId
        const wrong: AgentId = 'chat_1' as ChatId;
        void wrong;
    });
    it('accounts are refs an agent binds to, and a task, a chat note and a roster name the machine (#414)', () => {
        expectTypeOf<ExecutionDefaults['account']>().toEqualTypeOf<AccountRef | undefined>();
        expectTypeOf<AccountRef>().toEqualTypeOf<{ readonly identity?: string; readonly label?: string }>();
        expectTypeOf<TaskContract['machineId']>().toEqualTypeOf<MachineId | undefined>();
        expectTypeOf<Extract<ChatEntry, { t: 'msg' }>['machine']>().toEqualTypeOf<{ readonly id: MachineId | null } | undefined>();
        expectTypeOf<ChatRoster['machine']>().toEqualTypeOf<{ readonly id: MachineId; readonly name: string } | undefined>();
        expectTypeOf<QuotaAccount['key']>().toEqualTypeOf<AccountKey | undefined>();
    });
    it('instruction proposals always require review', () => {
        expectTypeOf<Extract<Proposal, { kind: 'instruction' }>['requiresReview']>().toEqualTypeOf<true>();
    });
});
