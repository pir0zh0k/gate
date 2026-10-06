import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
describe('configuration', () => {
  it('requires an exact origin and database URL', () => {
    expect(() => loadConfig({})).toThrow();
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://localhost/gate',
        APP_ORIGIN: 'http://localhost:5173',
      }),
    ).toMatchObject({
      appOrigin: 'http://localhost:5173',
      generationTimeoutMs: 120000,
      model: 'gpt-5.6-terra',
    });
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/gate',
        APP_ORIGIN: 'https://example.com/path',
      }),
    ).toThrow();
  });
  it('does not expose a malformed database URL in validation errors', () => {
    const secret = 'not-a-url-with-private-password';
    try {
      loadConfig({ DATABASE_URL: secret, APP_ORIGIN: 'http://gate.test' });
      throw new Error('Expected invalid URL');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
