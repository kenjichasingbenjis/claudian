import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../core/prompt/titleGeneration';
import { getRuntimeEnvironmentText } from '../../core/providers/providerEnvironment';
import type { TitleGenerationCallback, TitleGenerationService } from '../../core/providers/types';
import type ClaudianPlugin from '../../main';
import { parseEnvironmentVariables } from '../../utils/env';
import { sendMessage } from './apiClient';

export class MobileTitleGenerationService implements TitleGenerationService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      await callback(conversationId, { success: false, error: 'API key not set' });
      return;
    }

    this.abortController = new AbortController();
    const model = this.plugin.settings.titleGenerationModel || 'haiku';

    try {
      const title = await sendMessage(
        apiKey,
        [{ role: 'user', content: userMessage }],
        {
          model,
          systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
          maxTokens: 100,
          signal: this.abortController.signal,
        },
      );
      await callback(conversationId, { success: true, title: title.trim() });
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        const message = err instanceof Error ? err.message : String(err);
        await callback(conversationId, { success: false, error: message });
      }
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private getApiKey(): string | null {
    const envText = getRuntimeEnvironmentText(
      this.plugin.settings as unknown as Record<string, unknown>,
      'claude',
    );
    return parseEnvironmentVariables(envText)['ANTHROPIC_API_KEY'] || null;
  }
}
