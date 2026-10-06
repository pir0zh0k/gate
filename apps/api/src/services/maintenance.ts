import type { Repository } from '../models/repository.js';
type MaintenanceRepository = Pick<Repository, 'recoverStale' | 'cleanup'>;
export function startMaintenance(
  repository: MaintenanceRepository,
  staleMs: number,
  onError: (error: unknown) => void,
) {
  let running: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (running) return;
    running = (async () => {
      await repository.recoverStale(staleMs);
      await repository.cleanup();
    })()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  }, 60000);
  interval.unref();
  return {
    async stop(): Promise<void> {
      clearInterval(interval);
      await running;
    },
  };
}
