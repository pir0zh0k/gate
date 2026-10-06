import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import OpenAI from 'openai';
import { OpenAIProvider } from '../src/integrations/openai.js';
import { loadConfig } from '../src/config.js';
const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/gate',
  APP_ORIGIN: 'http://gate.test',
});
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers.length = 0;
});
it('uses stateless bounded Responses streaming through the official SDK', async () => {
  let received: unknown;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'data: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: 'actual transport' }) +
        '\n\n',
    );
    res.end('data: ' + JSON.stringify({ type: 'response.completed' }) + '\n\n');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const client = new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    baseURL: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
  });
  const provider = new OpenAIProvider(config, client);
  const parts: string[] = [];
  for await (const part of provider.stream(
    [{ role: 'user', content: 'Hi' }],
    new AbortController().signal,
  ))
    parts.push(part);
  expect(parts).toEqual(['actual transport']);
  expect(received).toMatchObject({
    model: 'gpt-5.6-terra',
    store: false,
    stream: true,
    max_output_tokens: 4096,
    input: [{ role: 'user', content: 'Hi' }],
  });
  expect(received).not.toHaveProperty('previous_response_id');
});
it('fails honestly when no API key is configured', async () => {
  const stream = new OpenAIProvider(config).stream(
    [{ role: 'user', content: 'Hi' }],
    new AbortController().signal,
  );
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('OPENAI_API_KEY');
});
