import type { INestApplicationContext } from '@nestjs/common';

/**
 * Signals that start Nest's shutdown sequence: `onModuleDestroy`,
 * `beforeApplicationShutdown`, closing the HTTP server, then
 * `onApplicationShutdown`. SIGTERM is what `docker stop` and container
 * orchestrators send (tini forwards it to node); SIGINT is Ctrl-C.
 *
 * Without `enableShutdownHooks`, Nest registers no signal listener and
 * Node's default action ends the process at once: in-flight requests
 * are cut, Prisma and Redis connections are dropped, and BullMQ workers
 * never close, leaving their active jobs to stall detection.
 *
 * After the sequence, Nest re-raises the signal, so the exit status
 * still reports it (143 for SIGTERM).
 */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export function enableGracefulShutdown(app: INestApplicationContext): void {
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS]);
}
