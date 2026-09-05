import type { StateStorage } from "zustand/middleware";

interface PendingStorageWrite {
  readonly value: string;
  readonly completion: Promise<void>;
}

/** Skip unchanged preference snapshots emitted by Zustand's transient updates. */
export function createDeduplicatingStorage(storage: StateStorage): StateStorage {
  const lastWrites = new Map<string, PendingStorageWrite>();
  const pendingOperations = new Map<string, Promise<void>>();

  function enqueue<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    // Preserve preference/reset order even when the underlying storage is async.
    const completion = (pendingOperations.get(name) ?? Promise.resolve()).then(operation);
    const settled = completion.then(
      () => undefined,
      () => undefined,
    );
    pendingOperations.set(name, settled);
    return completion;
  }

  return {
    getItem(name) {
      // Rehydration must observe storage changes made outside this adapter.
      lastWrites.delete(name);
      return enqueue(name, () => storage.getItem(name));
    },
    setItem(name, value) {
      const previous = lastWrites.get(name);
      if (previous?.value === value) {
        return previous.completion;
      }

      const completion = enqueue(name, async () => {
        await storage.setItem(name, value);
      });
      const write = { value, completion };
      lastWrites.set(name, write);
      void completion.catch(() => {
        // A failed write can be retried without invalidating a newer snapshot.
        if (lastWrites.get(name) === write) {
          lastWrites.delete(name);
        }
      });
      return completion;
    },
    removeItem(name) {
      lastWrites.delete(name);
      return enqueue(name, async () => {
        await storage.removeItem(name);
      });
    },
  };
}
