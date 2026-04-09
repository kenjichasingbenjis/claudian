import type { ProviderTaskResultInterpreter, ProviderTaskTerminalStatus } from '../../core/providers/types';

/**
 * No-op task result interpreter for mobile.
 * Tool use is not supported on mobile, so all methods return defaults.
 */
export class MobileTaskResultInterpreter implements ProviderTaskResultInterpreter {
  hasAsyncLaunchMarker(): boolean {
    return false;
  }

  extractAgentId(): string | null {
    return null;
  }

  extractStructuredResult(): string | null {
    return null;
  }

  resolveTerminalStatus(
    _toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus {
    return fallbackStatus;
  }

  extractTagValue(): string | null {
    return null;
  }
}
