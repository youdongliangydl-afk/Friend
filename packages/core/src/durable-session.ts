import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import { Harness, watchEvents, type EnvTarget, type Extension, type Registry, type Storage } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai';
import type { Bus, JsonObject, PluginController, PluginRegistrationOptions } from './index.js';
import { createDurablePluginHost, durablePiEntries, type PiShapedEntry } from './durable-plugin-host.js';
import type { DurableEntryLike } from './durable-projection.js';
import { translateAgentEvents, type PiWorkerEvent } from './durable-events.js';

/**
 * A session surface over Pi Durable, shaped so the desktop worker can drive it the way it drives
 * `AgentSession`.
 *
 * One requirement shapes most of this file: the worker matches messages by **object identity**
 * (`sessionManager.getEntries().find(entry => entry.message === measuredMessage)`). Re-projecting on
 * every call would return fresh objects and silently break session metrics, user-input hashing and
 * stream commits. Projected entries are therefore cached per entry id and handed back by reference.
 */

export interface DurableSessionPlugin {
  readonly name: string;
  readonly controller: PluginController;
  readonly description: string;
  readonly options?: PluginRegistrationOptions;
}

export interface DurableSessionOptions {
  cwd: string;
  storage: Storage;
  /** Any pi-ai `Models`; this project passes its existing `ModelRuntime`. */
  models: Models;
  registry: Registry;
  bus: Bus;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  plugins?: readonly DurableSessionPlugin[];
  /** Plain Pi extension factories, for the worker's own extensions that are not PluginControllers. */
  factories?: readonly ((pi: never) => unknown)[];
  /**
   * Durable extensions that must also be selected — `CodingTools` supplies read/write/edit/bash,
   * which on Pi came from the built-in tool set and therefore arrive from nowhere here.
   */
  extensions?: readonly Extension[];
  /** Builds the execution environment per use; without one those tools fail with an error result. */
  env?: (target: EnvTarget, context: Context) => unknown;
  agent?: { model?: { provider: string; modelId: string }; thinkingLevel?: string };
  policy?(sessionId: string): JsonObject | undefined;
  expertEvaluation?(sessionId: string): unknown;
  /** Reported to callers that expect a path; Durable keeps no JSONL transcript of its own. */
  sessionFile?: string;
  context?: Context;
}

export interface DurableSessionStats {
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolResults: number;
}

export interface DurableSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isIdle: boolean;
  readonly isStreaming: boolean;
  readonly model: { provider: string; id: string } | undefined;
  readonly thinkingLevel: string;
  readonly messages: readonly unknown[];
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getEntries(): readonly PiShapedEntry[];
    getBranch(): readonly PiShapedEntry[];
    appendCustomEntry(kind: string, data: unknown): Promise<unknown>;
  };
  readonly extensionRunner: {
    getUIContext(): unknown;
    getRegisteredCommands(): readonly { name: string; description?: string }[];
  };
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: PiWorkerEvent) => void): () => void;
  setModel(model: { provider: string; id: string }): Promise<boolean>;
  setThinkingLevel(level: string): void;
  getSessionStats(): DurableSessionStats;
  bindExtensions(): Promise<void>;
  /** Drop every mounted capability so the next `bindExtensions()` re-mounts the current set. */
  reload(): Promise<void>;
  dispose(): Promise<void>;
}

function roleOf(entry: PiShapedEntry): string | undefined {
  const message = entry.message as { role?: unknown } | undefined;
  return typeof message?.role === 'string' ? message.role : undefined;
}

export async function openDurableSession(options: DurableSessionOptions): Promise<DurableSession> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  // The agent choices belong to the conversation, not to the harness.
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry: options.registry,
      ...(options.env ? { env: options.env as never } : {}),
    } as never,
    context,
  );
  const conversation = await harness.root(context, (options.agent ? { agent: options.agent } : undefined) as never);

  /** Raw durable entries, oldest first, so the plugin host projects from the source of truth. */
  let rawEntries: readonly DurableEntryLike[] = [];
  /** Projected entries keyed by durable entry id, so identity comparisons keep working. */
  const projected = new Map<string, PiShapedEntry>();
  let entriesAscending: PiShapedEntry[] = [];
  let idle = true;
  let streaming = false;
  let thinking = options.agent?.thinkingLevel ?? 'medium';
  const listeners = new Set<(event: PiWorkerEvent) => void>();

  async function loadEntries(): Promise<void> {
    // Durable scans newest-first; history consumers read oldest-first.
    const page = await conversation.entries({}, 1000, undefined, context);
    const ordered = [...page.items].reverse();
    rawEntries = ordered as unknown as readonly DurableEntryLike[];
    const next: PiShapedEntry[] = [];
    for (const entry of ordered) {
      const id = String(entry.id);
      const cached = projected.get(id);
      if (cached !== undefined) { next.push(cached); continue; }
      const [fresh] = durablePiEntries([entry as never]);
      if (fresh === undefined) continue;
      projected.set(id, fresh);
      next.push(fresh);
    }
    const live = new Set(next.map(entry => entry.id));
    for (const id of [...projected.keys()]) if (!live.has(id)) projected.delete(id);
    entriesAscending = next;
  }

  const host = createDurablePluginHost({
    bus: options.bus,
    cwd: options.cwd,
    conversation: {
      id: String(conversation.id),
      entries: () => rawEntries,
      append: (kind, data) => {
        void conversation.commit(tx => tx.appendEntry(conversation.id, { kind, data } as never), context);
        return undefined;
      },
      file: () => options.sessionFile,
      isIdle: () => idle,
    },
    models: {
      available: () => [],
      find: () => undefined,
      current: () => (options.agent?.model ? { provider: options.agent.model.provider, id: options.agent.model.modelId } : undefined),
      thinkingLevel: () => thinking,
    },
    confirm: options.confirm,
    notify: options.notify,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.expertEvaluation ? { expertEvaluation: options.expertEvaluation } : {}),
  });

  /**
   * Build the durable extension from everything mounted so far, publish it, and select it on this
   * conversation. Installing alone is not enough: a conversation resolves its extension set when it
   * is created, and this one exists before anything was mounted.
   */
  const install = async () => {
    const extension = host.buildExtension('friend-pi');
    const extras = options.extensions ?? [];
    options.registry.install(extension as never);
    for (const extra of extras) options.registry.install(extra as never);
    // Awaited: submitting before selection lands would run the turn without the prompt section or
    // without its file tools.
    await conversation.configure({ extensions: [extension, ...extras] } as never, context);
  };
  const mountAll = async () => {
    for (const plugin of options.plugins ?? []) host.mount(plugin.name, plugin.controller, plugin.description, plugin.options);
    for (const factory of options.factories ?? []) host.mountFactory(factory as never);
    host.sessionStart();
    await install();
  };
  await mountAll();

  const stream = await watchEvents(harness, conversation.id, context);
  await stream.start(async events => {
    const translated = translateAgentEvents(events as readonly unknown[]);
    if (translated.length === 0) return;
    // Persist before notifying: listeners read `sessionManager` synchronously and must see the
    // entry the event refers to.
    const touchesHistory = translated.some(event => event.type === 'message_end' || event.type === 'agent_settled');
    if (touchesHistory) await loadEntries().catch(() => undefined);
    for (const event of translated) {
      if (event.type === 'agent_start') {
        idle = false;
        // Pi fired `before_agent_start` once per turn; durable has no such event, so the run
        // boundary is the equivalent moment. Running it here also refreshes the prompt section
        // before the first request of the run is rendered.
        host.beforeAgentStart();
      }
      if (event.type === 'agent_settled') { idle = true; streaming = false; }
      if (event.type === 'message_start') streaming = true;
      if (event.type === 'message_end') streaming = false;
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* a listener must not break the stream */ }
      }
    }
  });
  await loadEntries();

  return {
    sessionId: String(conversation.id),
    sessionFile: options.sessionFile,
    get isIdle() { return idle; },
    get isStreaming() { return streaming; },
    get model() {
      const agent = options.agent?.model;
      return agent ? { provider: agent.provider, id: agent.modelId } : undefined;
    },
    get thinkingLevel() { return thinking; },
    get messages() { return entriesAscending.filter(entry => entry.type === 'message').map(entry => entry.message); },
    sessionManager: {
      getSessionId: () => String(conversation.id),
      getSessionFile: () => options.sessionFile,
      getEntries: () => entriesAscending,
      getBranch: () => entriesAscending,
      appendCustomEntry: async (kind, data) => {
        const entry = await conversation.commit(tx => tx.appendEntry(conversation.id, { kind, data } as never), context);
        await loadEntries();
        return entry === undefined ? undefined : String(entry.id);
      },
    },
    extensionRunner: {
      getUIContext: () => ({ confirm: options.confirm, notify: options.notify }),
      // Slash commands live in the host; the worker lists them through its own registry.
      getRegisteredCommands: () => [],
    },
    async prompt(text) {
      idle = false;
      // Durable may commit the first system entry before `run_start` reaches us, so refresh the
      // captured prompt here as well; otherwise a contribution would only land on the second turn.
      host.beforeAgentStart();
      const submission = await conversation.submit({ type: 'input', content: text } as never, context);
      void submission.wait(context).then(async settled => {
        if (settled.status !== 'done') idle = true;
        await loadEntries().catch(() => undefined);
      }).catch(() => { idle = true; });
    },
    async abort() {
      await conversation.abort(context);
      idle = true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async setModel(model) {
      await conversation.configure({ model: { provider: model.provider, modelId: model.id } } as never, context);
      return true;
    },
    setThinkingLevel(level) { thinking = level; },
    getSessionStats() {
      return {
        userMessages: entriesAscending.filter(entry => roleOf(entry) === 'user').length,
        assistantMessages: entriesAscending.filter(entry => roleOf(entry) === 'assistant').length,
        toolResults: entriesAscending.filter(entry => roleOf(entry) === 'toolResult').length,
      };
    },
    async bindExtensions() { host.sessionStart(); },
    async reload() {
      await host.dispose();
      await mountAll();
    },
    async dispose() {
      await stream.stop().catch(() => undefined);
      for (const listener of [...listeners]) listeners.delete(listener);
      await host.dispose();
      await harness.close(context);
    },
  };
}
