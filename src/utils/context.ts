import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  playerId?: string;
  gameId?: string;
  drawSeq?: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Ambient attribution for the current unit of work — one inbound message, or
 * one draw tick.
 *
 * Every outbound message sent inside `run` is logged against that player and
 * game automatically. The alternative was passing a context object through
 * twenty call sites, which works right up until someone adds the twenty-first
 * and quietly loses the attribution.
 */
export function runWithContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Adds to the ambient context in place — e.g. once a game is identified. */
export function amendContext(patch: RequestContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

/** Explicit values win; anything missing falls back to the ambient context. */
export function mergeContext(explicit?: RequestContext): RequestContext {
  const ambient = storage.getStore();
  if (!ambient) return explicit ?? {};
  return {
    playerId: explicit?.playerId ?? ambient.playerId,
    gameId: explicit?.gameId ?? ambient.gameId,
    drawSeq: explicit?.drawSeq ?? ambient.drawSeq,
  };
}
