import { logContext } from '../logger.js';

const userLocks = new Map<string, Promise<unknown>>();

export function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next: Promise<unknown> = prev.then(
    () => logContext.run(userId, fn),
    () => logContext.run(userId, fn),
  );
  const clear = () => { if (userLocks.get(userId) === next) userLocks.delete(userId); };
  void next.then(clear, clear);
  userLocks.set(userId, next);
  return next as Promise<T>;
}
