import { Platform } from 'obsidian';

import { ProviderRegistry } from '../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../core/providers/ProviderWorkspaceRegistry';
import { claudeWorkspaceRegistration } from './claude/app/ClaudeWorkspaceServices';
import { claudeProviderRegistration } from './claude/registration';
import { mobileClaudeRegistration } from './claude-mobile/registration';
import { codexWorkspaceRegistration } from './codex/app/CodexWorkspaceServices';
import { codexProviderRegistration } from './codex/registration';

let builtInProvidersRegistered = false;

export function registerBuiltInProviders(): void {
  if (builtInProvidersRegistered) return;

  if (Platform?.isMobile) {
    ProviderRegistry.register('claude', mobileClaudeRegistration);
  } else {
    ProviderRegistry.register('claude', claudeProviderRegistration);
    ProviderRegistry.register('codex', codexProviderRegistration);
    ProviderWorkspaceRegistry.register('claude', claudeWorkspaceRegistration);
    ProviderWorkspaceRegistry.register('codex', codexWorkspaceRegistration);
  }

  builtInProvidersRegistered = true;
}

// Side-effect registration for backward compatibility with existing imports
registerBuiltInProviders();
