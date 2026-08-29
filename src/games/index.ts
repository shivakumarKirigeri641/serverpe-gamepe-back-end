import { registerEngine } from '../core/registry.js';
import { tambolaEngine } from './tambola/engine.js';

/**
 * Single place where games are switched on. Add a new engine here and the
 * whole platform — menus, lobbies, draw worker, claim flow — picks it up.
 */
export function registerAllGames(): void {
  registerEngine(tambolaEngine);
}
