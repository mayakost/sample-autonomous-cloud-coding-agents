/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import { CliError } from '../src/errors';
import {
  buildAuthorizationUrl,
  computeExpiresAt,
  exchangeAuthorizationCode,
  fetchAccessibleResources,
  generatePkce,
  isAccessTokenExpiring,
  JIRA_AUTHORIZE_ENDPOINT,
  JIRA_OAUTH_SCOPES,
  JIRA_TOKEN_ENDPOINT,
  jiraOauthSecretName,
  refreshAccessToken,
} from '../src/jira-oauth';

describe('jiraOauthSecretName', () => {
  test('prefixes with bgagent-jira-oauth-', () => {
    expect(jiraOauthSecretName('cloud-1')).toBe('bgagent-jira-oauth-cloud-1');
    expect(jiraOauthSecretName('11112222-3333-4444-5555-666677778888'))
      .toBe('bgagent-jira-oauth-11112222-3333-4444-5555-666677778888');
  });
});

describe('JIRA_OAUTH_SCOPES', () => {
  test('matches the documented v1 scope set including offline_access', () => {
    // Locked: dropping offline_access means no refresh_token and the
    // integration cannot self-renew (setup hard-fails on its absence).
    expect(JIRA_OAUTH_SCOPES).toEqual([
      'read:jira-work',
      'write:jira-work',
      'read:jira-user',
      'offline_access',
    ]);
  });
});

describe('generatePkce', () => {
  test('produces base64url-encoded verifier and SHA-256 challenge', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url-encoded SHA-256 = 43 chars (256 bits / 6 bits per char, no padding)
    expect(codeChallenge.length).toBe(43);
  });

  test('generates fresh values on each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe('buildAuthorizationUrl', () => {
  const base = {
    clientId: 'client-1',
    redirectUri: 'http://localhost:8080/oauth/callback',
    state: 'state-xyz',
    codeChallenge: 'challenge-abc',
  };

  test('targets the Atlassian authorize endpoint with the required params', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(`${url.origin}${url.pathname}`).toBe(JIRA_AUTHORIZE_ENDPOINT);
    // `audience` is Atlassian-specific and REQUIRED — omitting it yields a
    // confusing invalid_client at the consent screen.
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(base.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  test('defaults to the full scope set (space-joined)', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(url.searchParams.get('scope')).toBe(JIRA_OAUTH_SCOPES.join(' '));
  });

  test('honors a custom scope list', () => {
    const url = new URL(buildAuthorizationUrl({ ...base, scopes: ['read:jira-work'] }));
    expect(url.searchParams.get('scope')).toBe('read:jira-work');
  });
});

describe('isAccessTokenExpiring', () => {
  test('false when expiry is comfortably in the future', () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    expect(isAccessTokenExpiring(future)).toBe(false);
  });

  test('true when expiry is inside the 60s threshold', () => {
    const soon = new Date(Date.now() + 30 * 1000).toISOString();
    expect(isAccessTokenExpiring(soon)).toBe(true);
  });

  test('true when expiry is in the past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isAccessTokenExpiring(past)).toBe(true);
  });

  test('true (fail-safe) on an unparsable timestamp', () => {
    expect(isAccessTokenExpiring('not-a-date')).toBe(true);
  });
});

describe('computeExpiresAt', () => {
  test('adds expires_in seconds to now', () => {
    const now = new Date('2026-06-11T00:00:00.000Z');
    expect(computeExpiresAt(3600, now)).toBe('2026-06-11T01:00:00.000Z');
  });
});

function jsonResponse(body: unknown, status: number = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const TOKEN_OK = {
  access_token: 'jira_at_1',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'jira_rt_1',
  scope: 'read:jira-work write:jira-work read:jira-user offline_access',
};

describe('exchangeAuthorizationCode', () => {
  test('POSTs a JSON body (NOT form-encoded — the Atlassian divergence from Linear)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(TOKEN_OK));
    const result = await exchangeAuthorizationCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:8080/oauth/callback',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual(TOKEN_OK);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(JIRA_TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: 'verifier',
      redirect_uri: 'http://localhost:8080/oauth/callback',
      client_id: 'cid',
      client_secret: 'csec',
    });
  });

  test('throws CliError with error_description on a 4xx token response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(
      { error: 'invalid_grant', error_description: 'authorization code expired' },
      400,
    ));
    await expect(exchangeAuthorizationCode({
      code: 'stale',
      codeVerifier: 'v',
      redirectUri: 'r',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/invalid_grant: authorization code expired/);
  });

  test('throws CliError on a non-JSON response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    } as unknown as Response);
    await expect(exchangeAuthorizationCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'r',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(CliError);
  });

  test('throws CliError when the response shape is missing access_token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ token_type: 'Bearer' }));
    await expect(exchangeAuthorizationCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'r',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/unexpected shape/);
  });

  test('tolerates a missing refresh_token at this layer (setup enforces it later)', async () => {
    // The exchange itself returns whatever Atlassian sent; the hard
    // requirement for refresh_token is enforced by `bgagent jira setup`
    // so the error message can explain the offline_access fix.
    const { refresh_token: _refreshToken, ...withoutRefresh } = TOKEN_OK;
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(withoutRefresh));
    const result = await exchangeAuthorizationCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'r',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.refresh_token).toBeUndefined();
  });
});

describe('refreshAccessToken', () => {
  test('POSTs a refresh_token grant as JSON', async () => {
    const rotated = { ...TOKEN_OK, access_token: 'jira_at_2', refresh_token: 'jira_rt_2' };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(rotated));
    const result = await refreshAccessToken({
      refreshToken: 'jira_rt_1',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Atlassian ROTATES refresh tokens on every refresh — callers must
    // persist the new one. Pin that the rotated value comes through.
    expect(result.access_token).toBe('jira_at_2');
    expect(result.refresh_token).toBe('jira_rt_2');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(JIRA_TOKEN_ENDPOINT);
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'jira_rt_1',
      client_id: 'cid',
      client_secret: 'csec',
    });
  });

  test('surfaces invalid_grant (revoked/expired refresh token) as CliError', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(
      { error: 'invalid_grant', error_description: 'refresh token is invalid' },
      403,
    ));
    await expect(refreshAccessToken({
      refreshToken: 'revoked',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/invalid_grant/);
  });
});

describe('fetchAccessibleResources', () => {
  const SITES = [
    { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] },
    { id: 'cloud-2', url: 'https://other.atlassian.net', name: 'other', scopes: ['read:jira-work'] },
  ];

  test('GETs the accessible-resources endpoint with the bearer token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(SITES));
    const result = await fetchAccessibleResources('jira_at_1', fetchImpl as unknown as typeof fetch);

    expect(result).toEqual(SITES);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.atlassian.com/oauth/token/accessible-resources');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jira_at_1' });
  });

  test('throws CliError on a non-2xx response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, 401));
    await expect(fetchAccessibleResources('bad', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/accessible-resources query failed/);
  });

  test('throws CliError when the response is not an array', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ sites: [] }));
    await expect(fetchAccessibleResources('t', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/unexpected shape/);
  });
});
