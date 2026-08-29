/**
 * A sleep that a shutdown can cut short.
 *
 * The background loops poll on an interval. Without this, stopping one means waiting out
 * the full interval (up to an hour for retention), which leaves timers and database
 * queries running past the point where the owner considers itself stopped — the shape of
 * bug that makes a test runner report "the event loop has already resolved".
 */
export function createClock() {
  const waiters = new Set();
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    sleep(ms) {
      if (cancelled) return Promise.resolve();
      return new Promise(resolve => {
        const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, ms);
        waiters.add(wake);
      });
    },
    cancel() { cancelled = true; for (const wake of [...waiters]) wake(); }
  };
}
