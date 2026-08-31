import type { GameEngine, GameKey } from './types.js';

const engines = new Map<GameKey, GameEngine<any, any, any>>();

export function registerEngine(engine: GameEngine<any, any, any>): void {
  if (engines.has(engine.key)) {
    throw new Error(`Game engine "${engine.key}" is already registered`);
  }
  engines.set(engine.key, engine);
}

export function getEngine(key: GameKey): GameEngine<any, any, any> {
  const engine = engines.get(key);
  if (!engine) throw new Error(`Unknown game "${key}"`);
  return engine;
}

export function hasEngine(key: GameKey): boolean {
  return engines.has(key);
}

export function listEngines(): GameEngine<any, any, any>[] {
  return [...engines.values()];
}

/** Test helper — production code never needs this. */
export function resetRegistry(): void {
  engines.clear();
}
