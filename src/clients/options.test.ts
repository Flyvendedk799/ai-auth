import { describe, expect, it } from 'vitest';
import {
  anthropicKeyOptions,
  anthropicSubscriptionOptions,
  codexOptions,
  antigravityCliOptions,
  antigravityKeyOptions,
  antigravity_STUDIO_BASE_URL,
  openAiKeyOptions,
  toCodeAssistRequest,
} from './options.js';

describe('client options', () => {
  it('generates correct anthropic options', () => {
    expect(anthropicKeyOptions('sk-ant-key')).toEqual({ apiKey: 'sk-ant-key' });

    const sub = anthropicSubscriptionOptions('oat-token');
    expect(sub.authToken).toBe('oat-token');
    expect(sub.apiKey).toBeNull();
    expect(sub.defaultHeaders?.['anthropic-beta']).toBeDefined();
    expect(sub.defaultHeaders?.['x-app']).toBe('cli');
  });

  it('generates correct openai and codex options', () => {
    expect(openAiKeyOptions('sk-key')).toEqual({ apiKey: 'sk-key' });

    const codex = codexOptions({
      accessToken: 'access-jwt',
      refreshToken: null,
      accountId: 'acc-123',
      expiresAt: 12345,
      email: null,
      planType: 'plus',
    });
    expect(codex.apiKey).toBe('access-jwt');
    expect(codex.defaultHeaders?.['chatgpt-account-id']).toBe('acc-123');
  });

  it('generates correct antigravityKeyOptions', () => {
    const opts = antigravityKeyOptions('antigravity-api-key');
    expect(opts.apiKey).toBe('antigravity-api-key');
    expect(opts.baseURL).toBe(antigravity_STUDIO_BASE_URL);
  });

  it('generates correct antigravityCliOptions', () => {
    const opts = antigravityCliOptions({
      accessToken: 'ya29.test',
      refreshToken: null,
      expiresAt: 0,
      email: 'test@example.com',
      projectId: 'proj-456',
    });

    expect(opts.authToken).toBe('ya29.test');
    expect(opts.baseURL).toBe('https://cloudcode-pa.googleapis.com/v1internal');
    expect(opts.defaultHeaders?.Authorization).toBe('Bearer ya29.test');
    expect(opts.defaultHeaders?.['x-goog-user-project']).toBe('proj-456');
  });

  it('builds Code Assist generation payload correctly with toCodeAssistRequest', () => {
    const stringReq = toCodeAssistRequest('antigravity-2.5-flash', 'Hello world');
    expect(stringReq).toEqual({
      model: 'models/antigravity-2.5-flash',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
      },
    });

    const structuredReq = toCodeAssistRequest(
      'models/antigravity-2.5-pro',
      [{ role: 'user', parts: [{ text: 'Explain gravity' }] }],
      {
        projectId: 'gcp-project',
        systemInstruction: 'You are an astrophysicist',
        userPromptId: 'prompt-1',
      },
    );

    expect(structuredReq.model).toBe('models/antigravity-2.5-pro');
    expect(structuredReq.project).toBe('gcp-project');
    expect(structuredReq.user_prompt_id).toBe('prompt-1');
    expect(structuredReq.request.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'You are an astrophysicist' }],
    });
  });
});
