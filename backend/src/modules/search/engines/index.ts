import { logger } from '../../../core/utils/logger';
import type { ISearchEngine } from './ISearchEngine';
import { postgresSearchEngine } from './PostgresSearchEngine';

/**
 * Engine selection.
 *
 * The module resolves its engine exactly once, here, and every consumer imports
 * `activeSearchEngine`. This mirrors how `core/providers/storage` and
 * `core/providers/email` pick between a local and a hosted implementation, and
 * it is what makes "swap in OpenSearch later" a configuration change rather than
 * a refactor:
 *
 *   1. add `OpenSearchEngine implements ISearchEngine`
 *   2. add its name to the switch below
 *   3. set SEARCH_ENGINE=opensearch
 *
 * No route, controller, service, validator, cache key or test above this file
 * changes. `SEARCH_ENGINE` is deliberately NOT in `core/config/env` yet: adding
 * an environment variable with exactly one legal value would be ceremony, and
 * env.ts should gain it in the same change that gains a second engine.
 */
const ENGINES: Record<string, ISearchEngine> = {
  postgres: postgresSearchEngine,
};

function resolveEngine(): ISearchEngine {
  const requested = (process.env.SEARCH_ENGINE ?? 'postgres').toLowerCase();
  const engine = ENGINES[requested];

  if (!engine) {
    logger.warn(
      { requested, available: Object.keys(ENGINES) },
      'Unknown SEARCH_ENGINE — falling back to postgres'
    );
    return postgresSearchEngine;
  }
  return engine;
}

export const activeSearchEngine: ISearchEngine = resolveEngine();

export type { ISearchEngine } from './ISearchEngine';
export { PostgresSearchEngine, postgresSearchEngine } from './PostgresSearchEngine';
