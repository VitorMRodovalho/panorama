import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type INestApplication,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { enableGracefulShutdown, SHUTDOWN_SIGNALS } from '../src/bootstrap/shutdown-hooks.js';

/**
 * #338: main.ts never called `enableShutdownHooks`, so a SIGTERM ended
 * the process without running any destroy or shutdown hook.
 *
 * These tests run the listener Nest registers for each signal, on a
 * small app with a probe provider. No real signal is sent to the test
 * worker: the listener is called directly, and `process.kill` (Nest
 * re-raises the signal once the sequence is done) is stubbed.
 */

const calls: string[] = [];

@Injectable()
class ShutdownProbe implements OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  onModuleDestroy(): void {
    calls.push('onModuleDestroy');
  }
  beforeApplicationShutdown(signal?: string): void {
    calls.push(`beforeApplicationShutdown:${String(signal)}`);
  }
  onApplicationShutdown(signal?: string): void {
    calls.push(`onApplicationShutdown:${String(signal)}`);
  }
}

@Module({ providers: [ShutdownProbe] })
class ProbeModule {}

async function bootProbeApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

type Listeners = NodeJS.SignalsListener[];

function snapshot(): Record<string, Listeners> {
  return Object.fromEntries(SHUTDOWN_SIGNALS.map((s) => [s, process.listeners(s)]));
}

function added(signal: NodeJS.Signals, before: Listeners): Listeners {
  return process.listeners(signal).filter((l) => !before.includes(l));
}

describe('enableGracefulShutdown (#338)', () => {
  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  it.each(SHUTDOWN_SIGNALS)(
    '%s runs the destroy and shutdown hooks, then re-raises the signal',
    async (signal) => {
      const before = snapshot();
      const app = await bootProbeApp();
      enableGracefulShutdown(app);
      for (const s of SHUTDOWN_SIGNALS) expect(added(s, before[s] ?? [])).toHaveLength(1);

      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const [listener] = added(signal, before[signal] ?? []);
      listener?.(signal);
      // Nest's listener is async; the re-raise is its last step.
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, signal));

      expect(calls).toEqual([
        'onModuleDestroy',
        `beforeApplicationShutdown:${signal}`,
        `onApplicationShutdown:${signal}`,
      ]);
      // The sequence ends by unsubscribing from every signal it listened to.
      for (const s of SHUTDOWN_SIGNALS) expect(added(s, before[s] ?? [])).toHaveLength(0);
    },
  );

  it('without it, the app registers no signal listener (the state before #338)', async () => {
    const before = snapshot();
    const app = await bootProbeApp();
    for (const s of SHUTDOWN_SIGNALS) expect(added(s, before[s] ?? [])).toHaveLength(0);
    await app.close();
  });
});
