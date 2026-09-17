// The worker the workers pool runs: the actor half of `entry.cloudflare.ts`
// without the SSR build's virtual modules (those only exist in a Vite app build).
import { createActorHost, createActorWorker } from '../../src/actors.app';

export const ActorHost = createActorHost();

export default createActorWorker();
