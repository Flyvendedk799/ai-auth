import { describe, expect, it } from 'vitest';
import { startAntigravityLogin } from './oauth.js';

describe('startAntigravityLogin', () => {
  it('omits aicode on Dogfood — that client rejects it with restricted_client', () => {
    const started = startAntigravityLogin(true);
    const url = new URL(started.url);
    expect(url.searchParams.get('scope')).not.toContain('https://www.googleapis.com/auth/aicode');
    expect(url.searchParams.get('client_id')).toContain('884354919052');
  });

  it('requests aicode on the prod client — needed for a working consumer Cloud Code session', () => {
    const started = startAntigravityLogin(false);
    const url = new URL(started.url);
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/aicode');
    expect(url.searchParams.get('client_id')).toContain('1071006060591');
  });
});
