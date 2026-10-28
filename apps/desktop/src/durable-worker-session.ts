import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Models } from '@earendil-works/pi-ai';
import {
  importIsLossless,
  openDurableSession,
  piEntriesToDurableDrafts,
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

/** Read a Pi JSONL transcript into drafts, refusing anything the projection cannot carry. */
function importHistory(sessionFile: string | undefined): { kind: string; model?: readonly unknown[]; data?: unknown }[] | undefined {
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  const raw = readFileSync(sessionFile, 'utf8').trim();
  if (!raw) return undefined;
  const entries = raw.split('\n').flatMap(line => {
    try { return [JSON.parse(line) as never]; } catch { return []; }
  });
  // The first line is the Pi session header, not a transcript entry.
  const result = piEntriesToDurableDrafts(entries.slice(1));
  if (!importIsLossless(result))
    throw new Error(
      `会话历史不能无损导入到新执行后端：跳过 ${result.skipped.length} 条，重复 ID ${result.duplicateIds.length} 个。已拒绝切换，历史未被改动。`,
    );
  return result.drafts.length ? [...result.drafts] : undefined;
}

export async function openDurableWorkerSession(options: DurableWorkerSessionOptions): Promise<DurableWorkerSession> {
  // One storage per session keeps durable's "one process owns a storage" contract intact, because
  // the desktop already runs one worker process per session.
  const storagePath = join(options.dataDir, 'durable', `${options.sessionId}.sqlite`);
  // A session that lived on the Pi backend carries its transcript across on first open. Doing this
  // only when the file is new avoids re-importing into a store that already has the history.
  const initialEntries = existsSync(storagePath) ? undefined : importHistory(options.sessionFile);
  const storage = await openNodeSqliteStorage(storagePath);
  const capabilityFactories = await loadCapabilityFactories(options.extensionPaths);

  const session = await openDurableSession({
    cwd: options.cwd,
    // The product keys provenance, tombstones and queues on this id, not on the durable
    // conversation number.
    sessionId: options.sessionId,
    storage,
    models: options.models,
    registry: createRegistry(),
    bus: options.bus,
    confirm: options.confirm,
    notify: options.notify,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.expertEvaluation ? { expertEvaluation: options.expertEvaluation } : {}),
    ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
    // The readiness gate runs at the submit boundary; `streamSimple` must return its iterable
    // synchronously, so it cannot be awaited there.
    ...(options.beforeStream ? { beforePrompt: options.beforeStream } : {}),
    ...(initialEntries ? { initialEntries } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    // Pi shipped read/write/edit/bash as built-ins; durable has none, and without an environment its
    // own tool set fails every call.
    extensions: [CodingTools as never],
    env: (target: { cwd?: string }) => new NodeExecutionEnv({ cwd: target.cwd ?? options.cwd }),
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
