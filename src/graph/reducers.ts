/**
 * State reducers control how partial updates from nodes are merged into
 * the graph's state. Without reducers, it's a shallow Object.assign
 * (last write wins). With reducers, each key can have its own merge strategy.
 *
 * This solves the problem where two parallel nodes both update the same
 * array — without a reducer, the second node's write overwrites the first.
 * With an "append" reducer on that key, both writes are merged.
 *
 * ## Built-in reducers
 *
 * - `replace` — last write wins (default, same as Object.assign)
 * - `append` — concatenates arrays
 * - `union` — merges arrays, deduplicating by value
 * - `merge` — deep merge objects (1 level)
 * - `counter` — sums numeric values
 * - `custom` — user-provided function
 *
 * ## Usage
 *
 * ```ts
 * const graph = new AgentGraph<MyState>()
 *   .setReducers({
 *     messages: appendReducer<string>(),
 *     errors: appendReducer<string>(),
 *     toolResults: appendReducer<ToolResult>(),
 *     value: replaceReducer<number>(),
 *     metadata: mergeReducer(),
 *   })
 *   .addNode(...)
 *   .compile();
 * ```
 */

/**
 * A reducer function takes the current value and the incoming update value
 * and returns the merged result.
 *
 * If the update value is undefined, the current value is preserved.
 */
export type ReducerFn<V> = (current: V, update: V) => V;

/**
 * Map of state keys to their reducer functions.
 * Keys not in this map use the default "replace" strategy.
 */
export type StateReducers<S> = {
  [K in keyof S]?: ReducerFn<S[K]>;
};

// ─── Built-in Reducer Factories ──────────────────────────────────────────────

/**
 * Replace reducer — last write wins. This is the default behavior.
 */
export function replaceReducer<V>(): ReducerFn<V> {
  return (_current: V, update: V) => update;
}

/**
 * Append reducer — concatenates arrays.
 * Both current and update must be arrays.
 */
export function appendReducer<T>(): ReducerFn<T[]> {
  return (current: T[], update: T[]) => {
    if (!Array.isArray(current)) return update;
    if (!Array.isArray(update)) return current;
    return [...current, ...update];
  };
}

/**
 * Union reducer — merges arrays, deduplicating by strict equality.
 */
export function unionReducer<T>(): ReducerFn<T[]> {
  return (current: T[], update: T[]) => {
    if (!Array.isArray(current)) return update;
    if (!Array.isArray(update)) return current;
    const set = new Set(current);
    for (const item of update) {
      set.add(item);
    }
    return [...set];
  };
}

/**
 * Merge reducer — shallow merge for objects (1 level deep).
 * Useful for metadata/config objects where you want to add keys
 * without overwriting the entire object.
 */
export function mergeReducer<V extends Record<string, unknown>>(): ReducerFn<V> {
  return (current: V, update: V) => {
    if (!current || typeof current !== "object") return update;
    if (!update || typeof update !== "object") return current;
    return { ...current, ...update };
  };
}

/**
 * Counter reducer — sums numeric values.
 * Useful for step counts, token counts, etc.
 */
export function counterReducer(): ReducerFn<number> {
  return (current: number, update: number) => {
    return (current ?? 0) + (update ?? 0);
  };
}

/**
 * Custom reducer — user-provided merge function.
 */
export function customReducer<V>(fn: (current: V, update: V) => V): ReducerFn<V> {
  return fn;
}

// ─── State Merge with Reducers ───────────────────────────────────────────────

/**
 * Merge a partial state update into the current state using reducers.
 *
 * For each key in the update:
 * - If a reducer exists for that key, use it to merge
 * - Otherwise, replace (Object.assign behavior)
 *
 * Keys not in the update are preserved unchanged.
 */
export function mergeStateWithReducers<S extends Record<string, any>>(
  state: S,
  update: Partial<S>,
  reducers?: StateReducers<S>,
): S {
  if (!update || typeof update !== "object") return state;

  const result = { ...state };

  for (const key of Object.keys(update) as Array<keyof S>) {
    const updateValue = update[key];
    if (updateValue === undefined) continue;

    const reducer = reducers?.[key];
    if (reducer) {
      result[key] = reducer(state[key], updateValue as S[typeof key]);
    } else {
      result[key] = updateValue as S[typeof key];
    }
  }

  return result;
}
