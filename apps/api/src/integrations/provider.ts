export type AIInput = ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
export interface AIProvider {
  stream(input: AIInput, signal: AbortSignal): AsyncIterable<string>;
}
export class ProviderConfigurationError extends Error {
  readonly code = 'AI_NOT_CONFIGURED';
  constructor() {
    super('ИИ пока недоступен. Администратор должен настроить OPENAI_API_KEY на сервере.');
  }
}
