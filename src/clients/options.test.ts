import { describe, expect, it } from 'vitest';
import {
  anthropicKeyOptions,
  anthropicSubscriptionOptions,
  codexOptions,
  antigravityCliOptions,
  antigravityKeyOptions,
  antigravity_STUDIO_BASE_URL,
  CLOUD_CODE_DAILY_BASE_URL,
  normalizeAntigravityModelId,
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

  it('defaults antigravityCliOptions to daily and skips aicode-consumers header', () => {
    const opts = antigravityCliOptions({
      accessToken: 'ya29.test',
      refreshToken: null,
      expiresAt: 0,
      email: 'test@example.com',
      projectId: 'aicode-consumers',
    });

    expect(opts.authToken).toBe('ya29.test');
    expect(opts.baseURL).toBe(CLOUD_CODE_DAILY_BASE_URL);
    expect(opts.defaultHeaders?.Authorization).toBe('Bearer ya29.test');
    expect(opts.defaultHeaders?.['x-goog-user-project']).toBeUndefined();
    expect(opts.projectId).toBeUndefined();
  });

  it('puts a personal project on x-goog-user-project', () => {
    const opts = antigravityCliOptions({
      accessToken: 'ya29.test',
      refreshToken: null,
      expiresAt: 0,
      email: 'test@example.com',
      projectId: 'proj-456',
    });
    expect(opts.defaultHeaders?.['x-goog-user-project']).toBe('proj-456');
  });

  it('builds Code Assist generation payload with bare model ids', () => {
    const stringReq = toCodeAssistRequest('gemini-3-flash', 'Hello world');
    expect(stringReq).toEqual({
      model: 'gemini-3-flash',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
      },
    });

    const structuredReq = toCodeAssistRequest(
      'models/gemini-3.1-pro',
      [{ role: 'user', parts: [{ text: 'Explain gravity' }] }],
      {
        projectId: 'aicode-consumers',
        systemInstruction: 'You are an astrophysicist',
        userPromptId: 'prompt-1',
      },
    );

    expect(structuredReq.model).toBe('gemini-3.1-pro-low');
    expect(structuredReq.project).toBe('aicode-consumers');
    expect(structuredReq.user_prompt_id).toBe('prompt-1');
    expect(structuredReq.request.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'You are an astrophysicist' }],
    });
  });

  it('normalizeAntigravityModelId strips models/ and maps bare pro', () => {
    expect(normalizeAntigravityModelId('models/gemini-3-flash')).toBe('gemini-3-flash');
    expect(normalizeAntigravityModelId('gemini-3.1-pro')).toBe('gemini-3.1-pro-low');
  });
});
