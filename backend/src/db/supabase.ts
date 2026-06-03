import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

/**
 * When Supabase credentials are real, use the real client.
 * When they are placeholders, use an in-memory mock that implements just enough of the
 * query-builder chain to return empty results instantly, instead of the real client
 * hanging for 7 s on every call trying to reach a bogus URL.
 */
function buildMockSupabase(): SupabaseClient {
  // A thenable query-builder stub: `.from('...').select('*').eq(...).limit(...)` etc.
  // All read methods resolve to { data: [] | null, error: null }. Writes resolve to null.
  const EMPTY = Promise.resolve({ data: [], error: null });
  const NULL_SINGLE = Promise.resolve({ data: null, error: null });

  type Builder = PromiseLike<{ data: unknown; error: null }> & {
    [k: string]: unknown;
  };

  function makeBuilder(expectSingle = false): Builder {
    const settled = expectSingle ? NULL_SINGLE : EMPTY;
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) =>
        settled.then(resolve, reject),
    };
    const chain = (single = expectSingle) => makeBuilder(single);
    // Chainable query methods
    for (const m of [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike',
      'in', 'is', 'contains', 'containedBy', 'rangeGt', 'rangeLt',
      'rangeGte', 'rangeLte', 'rangeAdjacent', 'overlaps', 'textSearch',
      'match', 'not', 'or', 'filter', 'order', 'limit', 'range',
      'abortSignal', 'throwOnError', 'returns',
    ]) {
      builder[m] = () => chain();
    }
    builder.single = () => chain(true);
    builder.maybeSingle = () => chain(true);
    builder.csv = () => Promise.resolve({ data: '', error: null });
    return builder as Builder;
  }

  // Minimal surface covering everything the codebase uses.
  const mock = {
    from: (_table: string) => makeBuilder(),
    rpc: () => makeBuilder(),
    channel: () => ({ on: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }) }),
    removeChannel: () => {},
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      signOut: async () => ({ error: null }),
    },
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        download: async () => ({ data: null, error: null }),
        upload: async () => ({ data: null, error: null }),
      }),
    },
  } as unknown as SupabaseClient;

  return mock;
}

export const supabase: SupabaseClient = config.supabaseConfigured
  ? createClient(config.supabaseUrl, config.supabaseAnonKey)
  : buildMockSupabase();
