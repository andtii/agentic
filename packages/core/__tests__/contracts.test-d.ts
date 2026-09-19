import { expectTypeOf } from 'vitest';
import type { AgentId, ChatEntry, ChatFile, ChatFileBody, ChatFilePart, ChatFileRead, ChatFileStore, ChatId, DaemonFrame, EnvErrorCode, EnvironmentInput, EnvOp, FsErrorCode, FsOp, FsResult, OpenSpec, PlatformFrame, Principal, Proposal, RuntimeDriver, RuntimeOpenContext, TaskOrigin, TaskStatus, WaitReason } from '../src/index';

// Every union is closed: exhaustiveness holds and the discriminants are literal.
type Discriminant<T, K extends keyof T> = T[K];

describe('contract type tests', () => {
    it('task status and wait reasons are closed unions', () => {
        expectTypeOf<TaskStatus>().toEqualTypeOf<'queued' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'>();
        expectTypeOf<Discriminant<WaitReason, 'kind'>>().toEqualTypeOf<'approval' | 'input' | 'environment-offline' | 'child' | 'capacity' | 'budget'>();
        expectTypeOf<Discriminant<TaskOrigin, 'kind'>>().toEqualTypeOf<'user' | 'agent' | 'schedule' | 'trigger' | 'external'>();
    });
    it('chat entries and principals are discriminated', () => {
        expectTypeOf<Discriminant<ChatEntry, 't'>>().toEqualTypeOf<'msg' | 'member' | 'status' | 'coordinator' | 'rename'>();
        expectTypeOf<Discriminant<Principal, 'kind'>>().toEqualTypeOf<'user' | 'machine' | 'agent' | 'external'>();
    });
    it('daemon frames are versioned and generic over the wire types', () => {
        type F = { readonly kind: 'event' };
        expectTypeOf<Extract<DaemonFrame<F>, { t: 'session.frame' }>['frame']>().toEqualTypeOf<F>();
        expectTypeOf<DaemonFrame['v']>().toEqualTypeOf<1>();
        expectTypeOf<Discriminant<PlatformFrame, 't'>>().toEqualTypeOf<'welcome' | 'session.open' | 'session.command' | 'session.close' | 'tool.result' | 'ping' | 'fs.request' | 'env.request'>();
        expectTypeOf<Discriminant<Extract<PlatformFrame, { t: 'env.request' }>, 'op'>>().toEqualTypeOf<'put' | 'remove'>();
    });
    it('fs operations and results are closed unions', () => {
        expectTypeOf<Discriminant<FsOp, 'kind'>>().toEqualTypeOf<'list' | 'worktree'>();
        expectTypeOf<Discriminant<FsResult, 'kind'>>().toEqualTypeOf<'list' | 'worktree'>();
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
    it('instruction proposals always require review', () => {
        expectTypeOf<Extract<Proposal, { kind: 'instruction' }>['requiresReview']>().toEqualTypeOf<true>();
    });
});
