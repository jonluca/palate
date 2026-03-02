/**
 * Lightweight memoization utility for functions with primitive arguments.
 * Uses a simple Map with stringified keys for caching.
 * Assumes all arguments are strings, numbers, or booleans.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function memoize<T extends (...args: any[]) => any>(fn: T): T {
  const cache = new Map<string, ReturnType<T>>();

  return ((...args: Parameters<T>): ReturnType<T> => {
    const key = args.join("\0");
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const result = fn(...args) as ReturnType<T>;
    cache.set(key, result);
    return result;
  }) as T;
}
