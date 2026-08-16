/**
 * Lightweight memoization utility for functions with primitive arguments.
 * Uses a simple Map with stringified keys for caching.
 * Assumes all arguments are strings, numbers, or booleans.
 */
export function memoize<Arguments extends unknown[], Result>(
  fn: (...args: Arguments) => Result,
): (...args: Arguments) => Result {
  const cache = new Map<string, { readonly value: Result }>();

  return (...args: Arguments): Result => {
    const key = args.join("\0");
    const cached = cache.get(key);
    if (cached) {
      return cached.value;
    }
    const result = fn(...args);
    cache.set(key, { value: result });
    return result;
  };
}
