import type { Message, SendMessage } from '@gate/contracts';
import type { Repository } from '../models/repository.js';
import type { AIProvider } from '../integrations/provider.js';
export class GenerationService {
  constructor(
    private readonly repository: Repository,
    private readonly provider: AIProvider,
  ) {}
  async begin(sessionId: string, payload: SendMessage) {
    return this.repository.beginGeneration(sessionId, payload);
  }
  async *generate(
    input: Parameters<AIProvider['stream']>[0],
    signal: AbortSignal,
  ): AsyncIterable<string> {
    for await (const delta of this.provider.stream(input, signal)) {
      signal.throwIfAborted();
      yield delta;
    }
  }
  async save(id: string, content: string, status: Message['status']): Promise<Message> {
    return this.repository.saveMessage(id, content, status);
  }
}
