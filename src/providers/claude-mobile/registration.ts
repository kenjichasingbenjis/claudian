import type { ProviderCapabilities, ProviderRegistration } from '../../core/providers/types';
import { claudeSettingsReconciler } from '../claude/env/ClaudeSettingsReconciler';
import { claudeChatUIConfig } from '../claude/ui/ClaudeChatUIConfig';
import { MobileClaudeChatRuntime } from './MobileClaudeChatRuntime';
import { MobileHistoryService } from './MobileHistoryService';
import { MobileInlineEditService } from './MobileInlineEditService';
import { MobileInstructionRefineService } from './MobileInstructionRefineService';
import { MobileTaskResultInterpreter } from './MobileTaskResultInterpreter';
import { MobileTitleGenerationService } from './MobileTitleGenerationService';

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

export const mobileClaudeRegistration: ProviderRegistration = {
  displayName: 'Claude',
  blankTabOrder: 20,
  isEnabled: () => true,
  capabilities: MOBILE_CAPABILITIES,
  environmentKeyPatterns: [/^ANTHROPIC_/i, /^CLAUDE_/i],
  chatUIConfig: claudeChatUIConfig,
  settingsReconciler: claudeSettingsReconciler,
  createRuntime: ({ plugin }) => new MobileClaudeChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new MobileTitleGenerationService(plugin),
  createInstructionRefineService: (plugin) => new MobileInstructionRefineService(plugin),
  createInlineEditService: (plugin) => new MobileInlineEditService(plugin),
  historyService: new MobileHistoryService(),
  taskResultInterpreter: new MobileTaskResultInterpreter(),
};
