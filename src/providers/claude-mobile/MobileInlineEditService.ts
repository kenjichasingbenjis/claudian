import { buildInlineEditPrompt, getInlineEditSystemPrompt, parseInlineEditResponse } from '../../core/prompt/inlineEdit';
import { getRuntimeEnvironmentText } from '../../core/providers/providerEnvironment';
import type { InlineEditRequest, InlineEditResult, InlineEditService } from '../../core/providers/types';
import type ClaudianPlugin from '../../main';
import { parseEnvironmentVariables } from '../../utils/env';
import { sendMessage } from './apiClient';

export class MobileInlineEditService implements InlineEditService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.conversationHistory = [];
    const prompt = buildInlineEditPrompt(request);
    return this.callApi(prompt);
  }

  async continueConversation(message: string): Promise<InlineEditResult> {
    return this.callApi(message);
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async callApi(userMessage: string): Promise<InlineEditResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return { success: false, error: 'API key not set' };
    }

    this.abortController = new AbortController();
    this.conversationHistory.push({ role: 'user', content: userMessage });

    try {
      const response = await sendMessage(
        apiKey,
        this.conversationHistory,
        {
          model: this.plugin.settings.model || 'sonnet',
          systemPrompt: getInlineEditSystemPrompt(),
          maxTokens: 4096,
          signal: this.abortController.signal,
        },
      );

      this.conversationHistory.push({ role: 'assistant', content: response });
      return parseInlineEditResponse(response);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: 'Cancelled' };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    } finally {
      this.abortController = null;
    }
  }

  private getApiKey(): string | null {
    const envText = getRuntimeEnvironmentText(
      this.plugin.settings as unknown as Record<string, unknown>,
      'claude',
    );
    return parseEnvironmentVariables(envText)['ANTHROPIC_API_KEY'] || null;
  }
}
