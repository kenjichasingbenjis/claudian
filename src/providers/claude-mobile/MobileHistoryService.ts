import type { ProviderConversationHistoryService } from '../../core/providers/types';
import type { Conversation } from '../../core/types';

/**
 * Mobile history service.
 *
 * On mobile there is no access to ~/.claude/ JSONL session files.
 * Conversation messages are already persisted in the vault via the
 * session metadata system, so hydration is a no-op.
 */
export class MobileHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(): Promise<void> {
    // Messages are already in memory from vault metadata — nothing to hydrate.
  }

  async deleteConversationSession(): Promise<void> {
    // No external session files to clean up on mobile.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(): boolean {
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    return {};
  }
}
