import { afterEach, expect, it, vi } from 'vitest';
import { startMaintenance } from '../src/services/maintenance.js';
afterEach(() => vi.useRealTimers());
it('runs cleanup every minute without overlapping and stops cleanly', async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const maintenance = startMaintenance(
    {
      recoverStale: async () => {
        events.push('recover');
        return 0;
      },
      cleanup: async () => {
        events.push('cleanup');
        return { messages: 0, sessions: 0 };
      },
    },
    125000,
    () => undefined,
  );
  await vi.advanceTimersByTimeAsync(60000);
  expect(events).toEqual(['recover', 'cleanup']);
  await maintenance.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(events).toHaveLength(2);
});
