import OpenAI from 'openai';
import type { Config } from '../config.js';
import { ProviderConfigurationError, type AIInput, type AIProvider } from './provider.js';
export class OpenAIProvider implements AIProvider {
  private client: OpenAI | undefined;
  constructor(
    private readonly config: Config,
    client?: OpenAI,
  ) {
    this.client = client;
  }
  async *stream(input: AIInput, signal: AbortSignal): AsyncIterable<string> {
    if (!this.client) {
      if (!this.config.apiKey) throw new ProviderConfigurationError();
      this.client = new OpenAI({
        apiKey: this.config.apiKey,
        maxRetries: 0,
        timeout: this.config.generationTimeoutMs,
      });
    }
    const response = await this.client.responses.create(
      {
        model: this.config.model,
        input: input.map((message) => ({ ...message })),
        stream: true,
        store: false,
        max_output_tokens: this.config.maxOutputTokens,
      },
      { signal },
    );
    let completed = false;
    for await (const event of response) {
      signal.throwIfAborted();
      if (event.type === 'response.output_text.delta') yield event.delta;
      else if (event.type === 'response.completed') completed = true;
      else if (
        event.type === 'response.failed' ||
        event.type === 'response.incomplete' ||
        event.type === 'error' ||
        event.type === 'response.refusal.delta'
      )
        throw new Error('OpenAI response did not complete');
    }
    if (!completed) throw new Error('OpenAI stream ended before completion');
  }
}
