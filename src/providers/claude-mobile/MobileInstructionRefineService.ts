import { buildRefineSystemPrompt } from '../../core/prompt/instructionRefine';
import { getRuntimeEnvironmentText } from '../../core/providers/providerEnvironment';
import type { InstructionRefineService, RefineProgressCallback } from '../../core/providers/types';
import type { InstructionRefineResult } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { parseEnvironmentVariables } from '../../utils/env';
import { sendMessage } from './apiClient';

function parseRefineResponse(text: string): InstructionRefineResult {
  const instructionMatch = text.match(/<instruction>([\s\S]*?)<\/instruction>/);
  if (instructionMatch) {
    const remaining = text.replace(/<instruction>[\s\S]*?<\/instruction>/, '').trim();
    return {
      success: true,
      refinedInstruction: instructionMatch[1].trim(),
      clarification: remaining || undefined,
    };
  }
  return { success: true, clarification: text.trim() };
}

export class MobileInstructionRefineService implements InstructionRefineService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private existingInstructions = '';

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.conversationHistory = [];
    this.existingInstructions = '';
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    this.conversationHistory = [];
    this.existingInstructions = existingInstructions;
    return this.callApi(rawInstruction, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return this.callApi(message, onProgress);
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async callApi(
    userMessage: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
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
          systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
          maxTokens: 4096,
          signal: this.abortController.signal,
        },
      );

      this.conversationHistory.push({ role: 'assistant', content: response });
      return parseRefineResponse(response);
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
