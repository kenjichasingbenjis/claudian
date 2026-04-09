/**
 * Fetch-based Anthropic Messages API client for mobile.
 *
 * Uses streaming via SSE (Server-Sent Events) and works in any environment
 * that supports fetch() and ReadableStream (including Obsidian Mobile).
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20250501',
  sonnet: 'claude-sonnet-4-20250514',
  'sonnet[1m]': 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
  'opus[1m]': 'claude-opus-4-20250514',
};

export function resolveApiModelId(model: string): string {
  return MODEL_MAP[model] ?? model;
}

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: ApiContentBlock[] | string;
}

export type ApiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'thinking'; thinking: string };

export interface StreamOptions {
  model: string;
  maxTokens?: number;
  systemPrompt?: string;
  thinking?: { type: 'enabled'; budget_tokens: number };
  signal?: AbortSignal;
}

export type SSEEvent =
  | { type: 'message_start'; message: { id: string; model: string; usage: { input_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; text?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; thinking?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } };

export async function* streamMessages(
  apiKey: string,
  messages: ApiMessage[],
  options: StreamOptions,
): AsyncGenerator<SSEEvent> {
  const body: Record<string, unknown> = {
    model: resolveApiModelId(options.model),
    max_tokens: options.maxTokens ?? 8192,
    stream: true,
    messages,
  };

  if (options.systemPrompt) {
    body.system = options.systemPrompt;
  }

  if (options.thinking) {
    body.thinking = options.thinking;
    // Extended thinking requires higher max_tokens
    body.max_tokens = Math.max(body.max_tokens as number, options.thinking.budget_tokens + 4096);
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    let errorMessage: string;
    try {
      const parsed = JSON.parse(errorText);
      errorMessage = parsed.error?.message ?? errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(`Anthropic API error ${response.status}: ${errorMessage}`);
  }

  if (!response.body) {
    throw new Error('Response body is null — streaming not supported');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      // Keep the last incomplete chunk in the buffer
      buffer = events.pop() ?? '';

      for (const eventBlock of events) {
        const lines = eventBlock.split('\n');
        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6);
          }
        }

        if (eventType && eventData) {
          try {
            const parsed = JSON.parse(eventData) as SSEEvent;
            parsed.type = eventType as SSEEvent['type'];
            yield parsed;
          } catch {
            // Skip malformed JSON events
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Non-streaming single API call for auxiliary services. */
export async function sendMessage(
  apiKey: string,
  messages: ApiMessage[],
  options: Omit<StreamOptions, 'signal'> & { signal?: AbortSignal },
): Promise<string> {
  const body: Record<string, unknown> = {
    model: resolveApiModelId(options.model),
    max_tokens: options.maxTokens ?? 4096,
    messages,
  };

  if (options.systemPrompt) {
    body.system = options.systemPrompt;
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  const textBlocks = (result.content ?? []).filter(
    (b: { type: string }) => b.type === 'text',
  );
  return textBlocks.map((b: { text: string }) => b.text).join('');
}
