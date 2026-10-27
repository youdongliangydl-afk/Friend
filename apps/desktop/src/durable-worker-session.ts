import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Models } from '@earendil-works/pi-ai';
import {
  openDurableSession,
  type Bus,
  type DurableSession,
  type JsonObject,
} from '@friend-pi/core';

/**
 * Worker-facing durable session: the core facade plus the few `AgentSession` members the worker
 * touches that durable genuinely does not have.
 *
 * Every stub here is a deliberate, documented gap rather than an accident:
 * - `agent` exists only so the worker's Pi-only monkey patches (`onPayload`, `streamFunction`)
 *   remain assignable. Durable never calls them; the readiness gate is enforced by the `models`
 *   proxy below instead, which is the part that actually protects the user.
 * - `settingsManager.setExtensionPaths` and `reload` drive Pi's extension loader. Here extension
 *   membership is fixed at construction, so reload re-mounts what was mounted.
 * - `clearQueue` has no durable equivalent: queued input lives in the conversation inbox and the
 *   worker's own input queue decides admission.
 * - `abortCompaction` aborts the whole run, because durable tracks compaction as a task of it.
 */
export interface DurableWorkerSession extends DurableSession {
  readonly agent: { onPayload?: unknown; streamFunction?: unknown };
  readonly settingsManager: { setExtensionPaths(paths: readonly string[]): void };
  readonly resourceLoader: { reload(): Promise<void> };
  sendCustomMessage(draft: { customType: string; content: unknown; display?: boolean; details?: unknown }): Promise<unknown>;
  setSessionName(name: string): void;
  clearQueue(): void;
  abortCompaction(): void;
}

export interface DurableWorkerSessionOptions {
  cwd: string;
  dataDir: string;
  sessionId: string;
  sessionFile?: string;
  models: Models;
  bus: Bus;
  /** Absolute paths of enabled capability packages; their default export is an extension factory. */
  extensionPaths: readonly string[];
  /** The worker's own Pi extension factories (instructions, guard, services, documents, external). */
  factories: readonly ((pi: never) => unknown)[];
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  policy?(sessionId: string): JsonObject | undefined;
  expertEvaluation?(sessionId: string): unknown;
  agent?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
  /** Awaited before every provider stream; the same gate Pi applied through `streamFunction`. */
  beforeStream?(model: { provider: string; id: string }): Promise<void>;
}

/** Wrap the model catalog so the readiness gate still runs before a request leaves the process. */
function gateModels(models: Models, gate: ((model: { provider: string; id: string }) => Promise<void>) | undefined): Models {
  if (!gate) return models;
  return new Proxy(models as unknown as Record<string, unknown>, {
    get(target, property, receiver) {
      if (property !== 'streamSimple' && property !== 'stream') return Reflect.get(target, property, receiver);
      const original = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      if (typeof original !== 'function') return original;
      return async (...args: unknown[]) => {
        const model = args[0] as { provider?: unknown; id?: unknown } | undefined;
        if (typeof model?.provider === 'string' && typeof model.id === 'string') await gate({ provider: model.provider, id: model.id });
        return original.apply(target, args);
      };
    },
  }) as unknown as Models;
}

/** Load enabled capability packages and hand back their factories. */
async function loadCapabilityFactories(paths: readonly string[]): Promise<((pi: never) => unknown)[]> {
  const factories: ((pi: never) => unknown)[] = [];
  for (const path of paths) {
    const loaded = (await import(pathToFileURL(path).href)) as { default?: unknown; extension?: unknown };
    const factory = loaded.default ?? loaded.extension;
    if (typeof factory !== 'function') throw new Error(`能力包缺少默认导出的扩展工厂：${path}`);
    factories.push(factory as (pi: never) => unknown);
  }
  return factories;
}

export async function openDurableWorkerSession(options: DurableWorkerSessionOptions): Promise<DurableWorkerSession> {
  // One storage per session keeps durable's "one process owns a storage" contract intact, because
  // the desktop already runs one worker process per session.
  const storage = await openNodeSqliteStorage(join(options.dataDir, 'durable', `${options.sessionId}.sqlite`));
  const capabilityFactories = await loadCapabilityFactories(options.extensionPaths);

  const session = await openDurableSession({
    cwd: options.cwd,
    storage,
    models: gateModels(options.models, options.beforeStream),
    registry: createRegistry(),
    bus: options.bus,
    confirm: options.confirm,
    notify: options.notify,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.expertEvaluation ? { expertEvaluation: options.expertEvaluation } : {}),
    ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    // Capability packages arrive as factories so their `registerPlugin` call lands on the facade,
    // exactly as it would on Pi.
    factories: [...capabilityFactories, ...options.factories],
  });

  let sessionName: string | undefined;
  const worker: DurableWorkerSession = Object.assign(session, {
    agent: {},
    settingsManager: { setExtensionPaths: () => undefined },
    resourceLoader: { reload: async () => { await session.reload(); } },
    async sendCustomMessage(draft: { customType: string; content: unknown; display?: boolean; details?: unknown }) {
      return session.sessionManager.appendCustomEntry(draft.customType, {
        content: draft.content,
        ...(draft.display === undefined ? {} : { display: draft.display }),
        ...(draft.details === undefined ? {} : { details: draft.details }),
      });
    },
    setSessionName(name: string) { sessionName = name; },
    clearQueue() { /* admission is the worker's own input queue; durable keeps no separate one */ },
    abortCompaction() { void session.abort(); },
  }) as DurableWorkerSession;
  void sessionName;
  return worker;
}
