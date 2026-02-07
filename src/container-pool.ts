/**
 * Container Pool for NanoClaw
 * Pre-warms containers for registered groups to eliminate spawn latency.
 * Each warm container starts Node.js and blocks on readStdin(), ready for instant dispatch.
 */
import { ChildProcess, spawn } from 'child_process';

import { CONTAINER_POOL_MAX_IDLE, CONTAINER_RUNTIME } from './config.js';
import { logger } from './logger.js';

interface WarmEntry {
  process: ChildProcess;
  createdAt: number;
  idleTimer: NodeJS.Timeout | null;
  dead: boolean;
}

const pool = new Map<string, WarmEntry>();

/**
 * Acquire a warm container for a group. Returns the process or null.
 * The caller takes ownership — the pool no longer tracks this container.
 */
export function acquireWarmContainer(
  groupFolder: string,
): ChildProcess | null {
  const entry = pool.get(groupFolder);
  if (!entry || entry.dead) {
    if (entry) pool.delete(groupFolder);
    return null;
  }

  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  pool.delete(groupFolder);

  const warmMs = Date.now() - entry.createdAt;
  logger.info({ group: groupFolder, warmMs }, 'Acquired warm container');

  return entry.process;
}

/**
 * Pre-warm a container. Spawns the process and keeps it idle until acquired.
 * No-op if a warm container already exists for this group.
 */
export function warmContainer(
  groupFolder: string,
  containerArgs: string[],
): void {
  if (pool.has(groupFolder)) return;

  const proc = spawn(CONTAINER_RUNTIME, containerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entry: WarmEntry = {
    process: proc,
    createdAt: Date.now(),
    idleTimer:
      CONTAINER_POOL_MAX_IDLE > 0
        ? setTimeout(() => evict(groupFolder), CONTAINER_POOL_MAX_IDLE)
        : null,
    dead: false,
  };

  proc.on('close', () => {
    if (pool.get(groupFolder) === entry) {
      pool.delete(groupFolder);
      logger.debug({ group: groupFolder }, 'Warm container exited');
    }
  });

  proc.on('error', (err) => {
    entry.dead = true;
    if (pool.get(groupFolder) === entry) {
      pool.delete(groupFolder);
    }
    logger.warn({ group: groupFolder, err }, 'Warm container spawn error');
  });

  pool.set(groupFolder, entry);
  logger.debug({ group: groupFolder }, 'Container pre-warmed');
}

function evict(groupFolder: string): void {
  const entry = pool.get(groupFolder);
  if (!entry) return;

  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  pool.delete(groupFolder);

  if (!entry.dead) {
    entry.process.stdin?.end();
    entry.process.kill('SIGTERM');
    logger.debug({ group: groupFolder }, 'Evicted idle warm container');
  }
}

export function shutdownPool(): void {
  for (const folder of [...pool.keys()]) {
    evict(folder);
  }
  logger.info('Container pool shut down');
}
