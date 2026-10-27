import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerPlugin, type Bus, type PluginController, type PluginRegistrationOptions, type JsonObject } from './index.js';
import type { DurableEntryLike } from './durable-projection.js';

/**
 * Pi-shaped facade over a Pi Durable conversation.
 *
 * The four capability packages are Pi Packages: they receive an `ExtensionAPI` and register through
 * `registerPlugin`. Pi Durable has no such object, so instead of rewriting every plugin this module
 * fabricates one. Two consequences worth stating plainly:
 *
 * 1. Entry history is re-emitted in Pi's shape (`type` / `customType` / `message` / `summary`).
 *    Durable's own `kind` becomes `customType`, which is why the ~20 `customType` checks inside the
 *    capability packages keep working untouched.
 * 2. Whatever Pi offers and Durable does not (the extension runner, UI context, commands) is
 *    implemented here rather than emulated by accident. If a port is missing, mounting fails loudly.
 */

/** Pi-shaped session entry as the capability packages and `historyItems()` expect to read it. */
export interface PiShapedEntry {
  readonly id: string;
  readonly parentId: null;
  readonly type: 'message' | 'custom' | 'compaction';
  readonly timestamp: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: unknown;
  readonly summary?: string;
}

/** Durable kinds that carry a conversational message rather than a bookkeeping payload. */
const MESSAGE_KINDS: Record<string, true> = { 'pi.user': true, 'pi.assistant': true, 'pi.system': true, 'pi.tool-result': true };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Project one Durable entry onto Pi's entry shape.
 *
 * `parentId` stays `null`: Durable appends entries to a conversation in order and has no per-entry
 * parent link. Callers needing branch shape must use the conversation's own ancestry.
 */
export function toPiEntry(entry: DurableEntryLike): PiShapedEntry {
  const data = record(entry.data);
  const message = Array.isArray(entry.model) && entry.model.length ? entry.model[0] : undefined;
  const timestamp =
    message && typeof record(message).timestamp === 'number'
      ? new Date(Number(record(message).timestamp)).toISOString()
      : typeof data.timestamp === 'string'
        ? data.timestamp
        : '';
  if (MESSAGE_KINDS[entry.kind])
    return { id: String(entry.id), parentId: null, type: 'message', timestamp, ...(message === undefined ? {} : { message }) };
  if (entry.kind === 'pi.compaction')
    return { id: String(entry.id), parentId: null, type: 'compaction', timestamp, ...(typeof data.summary === 'string' ? { summary: data.summary } : {}) };
  // Every other kind keeps its identity as `customType`, which is exactly what Pi used to store.
  return { id: String(entry.id), parentId: null, type: 'custom', timestamp, customType: entry.kind, ...(entry.data === undefined ? {} : { data: entry.data }) };
}

/** Project a whole conversation. Order is preserved because callers rely on it. */
export function durablePiEntries(entries: readonly DurableEntryLike[]): PiShapedEntry[] {
  return entries.map(toPiEntry);
}

/** Conversation surface the host needs. P2 implements this over a Durable `Conversation`. */
export interface DurableConversationPort {
  readonly id: string;
  entries(): readonly DurableEntryLike[];
  /** Append a bookkeeping entry; returns the stored entry id when the backend reports one. */
  append(kind: string, data: unknown): unknown;
  /** Session file path when the backend keeps one, otherwise undefined. */
  file?(): string | undefined;
  /** True while a run is in flight, so `ctx.isIdle()` stays truthful. */
  isIdle?(): boolean;
}

/** Model surface the host needs. `ModelRuntime` satisfies this through a thin adapter. */
export interface DurableModelPort {
  available(): readonly { provider: string; id: string; thinkingLevels?: readonly string[] }[];
  find(provider: string, id: string): unknown | undefined;
  current(): { provider: string; id: string } | undefined;
  thinkingLevel(): string;
  setModel?(provider: string, id: string): Promise<boolean> | boolean;
  setThinkingLevel?(level: string): void;
}

export interface DurablePluginHostOptions {
  bus: Bus;
  cwd: string;
  conversation: DurableConversationPort;
  models: DurableModelPort;
  /** Blocks until the user answers; a rejection or a missing bridge must fail closed. */
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  signal?: AbortSignal;
  abort?(): void;
  /** Answers the policy downlink that `makeContext` asks for on every context build. */
  policy?(sessionId: string): JsonObject | undefined;
  /** Answers the expert-evaluation downlink; omit when the host has no evaluation service. */
  expertEvaluation?(sessionId: string): unknown;
}

export interface MountedPlugin {
  readonly name: string;
  readonly tools: readonly unknown[];
  readonly commands: readonly string[];
  dispose(): Promise<void>;
}

export interface DurablePluginHost {
  /** Register one capability package exactly as `registerPlugin` would on Pi. */
  mount(name: string, controller: PluginController, description: string, options?: PluginRegistrationOptions): MountedPlugin;
  /**
   * Register a plain Pi extension factory — the worker's own extensions (custom instructions,
   * guard, services, document tools, …) are written in that form and are not PluginControllers.
   * Returns the disposer the factory produced, when it produced one.
   */
  mountFactory(factory: (pi: ExtensionAPI) => unknown): (() => void) | undefined;
  /** Drive the lifecycle events the plugins subscribe to. */
  sessionStart(): void;
  beforeAgentStart(): void;
  sessionShutdown(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Build the facade and mount capability packages onto it.
 *
 * The host subscribes to the two downlink channels `makeContext` uses, because on Pi those were
 * answered by the desktop worker. Without an answer `policy` stays undefined and every capability
 * would silently lose its write scopes and execution mode.
 */
export function createDurablePluginHost(options: DurablePluginHostOptions): DurablePluginHost {
  const { bus, conversation, models } = options;
  const lifecycle = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const mounted: MountedPlugin[] = [];

  const offPolicy = bus.on('friend-pi:v1:policy', raw => {
    const request = record(raw);
    if (request.v !== 1 || typeof request.reply !== 'function') return;
    const sessionId = String(request.sessionId ?? '');
    if (sessionId !== conversation.id) return;
    const policy = options.policy?.(sessionId);
    if (!policy) return;
    (request.reply as (value: JsonObject) => void)(policy);
  });
  const offEvaluation = bus.on('friend-pi:v1:expert-evaluation', raw => {
    const request = record(raw);
    if (request.v !== 1 || typeof request.reply !== 'function') return;
    const sessionId = String(request.sessionId ?? '');
    if (sessionId !== conversation.id) return;
    const host = options.expertEvaluation?.(sessionId);
    if (!host) return;
    (request.reply as (value: unknown) => void)(host);
  });

  const sessionManager = {
    getSessionId: () => conversation.id,
    getSessionFile: () => conversation.file?.(),
    getEntries: () => durablePiEntries(conversation.entries()),
    getBranch: () => durablePiEntries(conversation.entries()),
  };
  const modelRegistry = {
    getAvailable: () => models.available().map(({ provider, id }) => ({ provider, id })),
    find: (provider: string, id: string) => models.find(provider, id),
  };

  function makeFakeContext(): ExtensionContext {
    const current = models.current();
    return {
      cwd: options.cwd,
      signal: options.signal,
      model: current,
      modelRegistry,
      sessionManager,
      ui: { confirm: options.confirm, notify: (message: string, level?: 'info' | 'warning' | 'error') => options.notify(message, level) },
      isIdle: () => conversation.isIdle?.() ?? true,
      abort: () => options.abort?.(),
    } as unknown as ExtensionContext;
  }

  function makeFakeApi(tools: unknown[], commands: string[]): ExtensionAPI {
    const api = {
      events: bus,
      on(event: string, handler: (payload: unknown, ctx: ExtensionContext) => unknown) {
        const handlers = lifecycle.get(event) ?? [];
        handlers.push(handler);
        lifecycle.set(event, handlers);
      },
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      appendEntry(kind: string, data: unknown) {
        return conversation.append(kind, data);
      },
      getThinkingLevel: () => models.thinkingLevel(),
      getAllTools: () => tools.map(tool => ({ name: String(record(tool).name ?? '') })),
      setModel: async (model: unknown) => {
        const target = record(model);
        if (typeof target.provider !== 'string' || typeof target.id !== 'string') return false;
        return (await models.setModel?.(target.provider, target.id)) ?? false;
      },
      setThinkingLevel: (level: string) => models.setThinkingLevel?.(level),
    };
    return api as unknown as ExtensionAPI;
  }

  function fire(event: string): void {
    const handlers = lifecycle.get(event) ?? [];
    const ctx = makeFakeContext();
    for (const handler of handlers) handler({ type: event }, ctx);
  }

  return {
    mount(name, controller, description, registration = {}) {
      const tools: unknown[] = [];
      const commands: string[] = [];
      registerPlugin(makeFakeApi(tools, commands), name, controller, description, registration);
      const plugin: MountedPlugin = {
        name,
        tools,
        commands,
        async dispose() {
          await controller.dispose?.();
        },
      };
      mounted.push(plugin);
      return plugin;
    },
    mountFactory(factory) {
      const tools: unknown[] = [];
      const commands: string[] = [];
      const result = factory(makeFakeApi(tools, commands));
      return typeof result === 'function' ? (result as () => void) : undefined;
    },
    sessionStart() {
      fire('session_start');
    },
    beforeAgentStart() {
      fire('before_agent_start');
    },
    async sessionShutdown() {
      const handlers = lifecycle.get('session_shutdown') ?? [];
      const ctx = makeFakeContext();
      for (const handler of handlers) await handler({ type: 'session_shutdown' }, ctx);
    },
    async dispose() {
      offPolicy();
      offEvaluation();
      await this.sessionShutdown();
      for (const plugin of mounted) await plugin.dispose().catch(() => undefined);
      mounted.length = 0;
      lifecycle.clear();
    },
  };
}
