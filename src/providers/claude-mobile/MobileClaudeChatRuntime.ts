/**
 * Mobile-compatible Claude chat runtime.
 *
 * Implements ChatRuntime using direct Anthropic Messages API calls via fetch().
 * No child_process, no fs, no Node.js APIs — works on Obsidian Mobile.
 */

import { Notice } from 'obsidian';

import { getRuntimeEnvironmentText } from '../../core/providers/providerEnvironment';
import type { ProviderCapabilities } from '../../core/providers/types';
import type { ChatRuntime } from '../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnResult,
  ChatRewindResult,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../core/runtime/types';
import type {
  ChatMessage,
  Conversation,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
  UsageInfo,
} from '../../core/types';
import type ClaudianPlugin from '../../main';
import { parseEnvironmentVariables } from '../../utils/env';
import { type ApiContentBlock, type ApiMessage, resolveApiModelId, streamMessages } from './apiClient';

const MOBILE_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'claude',
  supportsPersistentRuntime: false,
  supportsNativeHistory: false,
  supportsPlanMode: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});

const EFFORT_TO_BUDGET: Record<string, number> = {
  low: 4096,
  medium: 10240,
  high: 16384,
  max: 32768,
};

export class MobileClaudeChatRuntime implements ChatRuntime {
  readonly providerId = 'claude' as const;

  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private turnMetadata: ChatTurnMetadata = {};

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return MOBILE_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    const prompt = request.text;
    return {
      request,
      persistedContent: prompt,
      prompt,
      isCompact: false,
      mcpMentions: new Set(),
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  setResumeCheckpoint(): void { /* no-op */ }

  syncConversationState(): void { /* no-op */ }

  async reloadMcpServers(): Promise<void> { /* no-op */ }

  async ensureReady(): Promise<boolean> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      new Notice('ANTHROPIC_API_KEY not set. Add it in Settings → Environment Variables.');
      this.setReady(false);
      return false;
    }
    this.setReady(true);
    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      yield { type: 'error', content: 'ANTHROPIC_API_KEY not set. Add it in Settings → Environment Variables.' };
      yield { type: 'done' };
      return;
    }

    this.abortController = new AbortController();
    const model = queryOptions?.model ?? this.plugin.settings.model ?? 'sonnet';

    // Build API messages from conversation history
    const apiMessages = this.buildApiMessages(conversationHistory ?? [], turn);

    // Build thinking options
    const thinking = this.buildThinkingOptions(model);

    // System prompt
    const systemPrompt = this.plugin.settings.systemPrompt || undefined;

    yield { type: 'assistant_message_start' };

    try {
      const events = streamMessages(apiKey, apiMessages, {
        model,
        systemPrompt,
        thinking,
        signal: this.abortController.signal,
      });

      let inputTokens = 0;
      let outputTokens = 0;
      let responseModel = model;
      let sawText = false;

      for await (const event of events) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens;
            responseModel = event.message.model;
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta' && event.delta.text) {
              sawText = true;
              yield { type: 'text', content: event.delta.text };
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              yield { type: 'thinking', content: event.delta.thinking };
            }
            break;

          case 'message_delta':
            outputTokens = event.usage.output_tokens;
            break;

          case 'error':
            yield { type: 'error', content: event.error.message };
            break;
        }
      }

      if (!sawText) {
        yield { type: 'text', content: '' };
      }

      // Emit usage
      const contextTokens = inputTokens + outputTokens;
      const contextWindow = this.getContextWindow(model);
      const usage: UsageInfo = {
        model: resolveApiModelId(responseModel),
        inputTokens,
        contextWindow,
        contextTokens,
        percentage: contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0,
      };
      yield { type: 'usage', usage, sessionId: null };

    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled
      } else {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', content: message };
      }
    } finally {
      this.abortController = null;
    }

    yield { type: 'done' };
  }

  steer(): Promise<boolean> {
    return Promise.resolve(false);
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  resetSession(): void { /* no-op — stateless */ }

  getSessionId(): string | null {
    return null;
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.cancel();
  }

  async rewind(): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Rewind is not available on mobile' };
  }

  setApprovalCallback(_callback: ApprovalCallback | null): void { /* no-op */ }
  setApprovalDismisser(_dismisser: (() => void) | null): void { /* no-op */ }
  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void { /* no-op */ }
  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void { /* no-op */ }
  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void { /* no-op */ }
  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void { /* no-op */ }
  setAutoTurnCallback(_callback: ((result: AutoTurnResult) => void) | null): void { /* no-op */ }

  consumeTurnMetadata(): ChatTurnMetadata {
    const meta = this.turnMetadata;
    this.turnMetadata = {};
    return meta;
  }

  buildSessionUpdates(_params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    return { updates: {} };
  }

  resolveSessionIdForFork(): string | null {
    return null;
  }

  async loadSubagentToolCalls(): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(): Promise<string | null> {
    return null;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private getApiKey(): string | null {
    const envText = getRuntimeEnvironmentText(
      this.plugin.settings as unknown as Record<string, unknown>,
      'claude',
    );
    const vars = parseEnvironmentVariables(envText);
    return vars['ANTHROPIC_API_KEY'] || null;
  }

  private setReady(value: boolean): void {
    if (this.ready !== value) {
      this.ready = value;
      for (const listener of this.readyListeners) {
        listener(value);
      }
    }
  }

  private buildApiMessages(
    history: ChatMessage[],
    turn: PreparedChatTurn,
  ): ApiMessage[] {
    const messages: ApiMessage[] = [];

    for (const msg of history) {
      if (msg.isRebuiltContext || msg.isInterrupt) continue;

      const content: ApiContentBlock[] = [];

      if (msg.images?.length) {
        for (const img of msg.images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          });
        }
      }

      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }

      if (content.length > 0) {
        messages.push({
          role: msg.role,
          content: content.length === 1 && content[0].type === 'text'
            ? (content[0] as { type: 'text'; text: string }).text
            : content,
        });
      }
    }

    // Append the current turn
    const userContent: ApiContentBlock[] = [];

    if (turn.request.images?.length) {
      for (const img of turn.request.images) {
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        });
      }
    }

    userContent.push({ type: 'text', text: turn.prompt });

    messages.push({
      role: 'user',
      content: userContent.length === 1 && userContent[0].type === 'text'
        ? (userContent[0] as { type: 'text'; text: string }).text
        : userContent,
    });

    return messages;
  }

  private buildThinkingOptions(
    model: string,
  ): { type: 'enabled'; budget_tokens: number } | undefined {
    const settings = this.plugin.settings;
    const effortLevel = settings.effortLevel;

    if (!effortLevel || effortLevel === 'off' || effortLevel === 'none') {
      return undefined;
    }

    const budget = EFFORT_TO_BUDGET[effortLevel];
    if (!budget) return undefined;

    // Only enable thinking for models that support it
    const apiModelId = resolveApiModelId(model);
    if (apiModelId.includes('haiku')) return undefined;

    return { type: 'enabled', budget_tokens: budget };
  }

  private getContextWindow(model: string): number {
    if (model.endsWith('[1m]')) return 1_000_000;
    return 200_000;
  }
}
