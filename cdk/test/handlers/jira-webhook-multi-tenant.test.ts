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

/**
 * Per-tenant webhook signing-secret tests for the Jira webhook receiver —
 * the Jira analog of `linear-webhook-multi-workspace.test.ts`.
 *
 * Lives in a separate file from `jira-webhook.test.ts` because the handler
 * reads `JIRA_WORKSPACE_REGISTRY_TABLE_NAME` at module-load time. Setting
 * it here before the import gives us the multi-tenant code path; the
 * sibling test file leaves it unset to exercise the single-tenant
 * back-compat path.
 */

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  class ConditionalCheckFailedExceptionMock extends Error {
    constructor(opts: { message: string; $metadata?: unknown }) {
      super(opts.message);
      this.name = 'ConditionalCheckFailedException';
    }
  }
  return {
    DynamoDBClient: jest.fn(() => ({})),
    ConditionalCheckFailedException: ConditionalCheckFailedExceptionMock,
  };
});
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

process.env.JIRA_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/jira/webhook-stack';
process.env.JIRA_WEBHOOK_DEDUP_TABLE_NAME = 'JiraDedup';
process.env.JIRA_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'jira-processor';
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';

import { handler } from '../../src/handlers/jira-webhook';
import { _resetCachesForTesting } from '../../src/handlers/shared/jira-oauth-resolver';
import { invalidateJiraSecretCache } from '../../src/handlers/shared/jira-verify';

const STACK_WIDE_SECRET = 'jira-stackwide-secret-AAAAAAAAAAAAAAAAAA';
const TENANT_A_SECRET = 'jira-tenantA-secret-BBBBBBBBBBBBBBBBBB';
const TENANT_B_SECRET = 'jira-tenantB-secret-CCCCCCCCCCCCCCCCCC';
const TENANT_A_CLOUD_ID = 'cloud-aaa';
const TENANT_B_CLOUD_ID = 'cloud-bbb';
const TENANT_A_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-jira-oauth-cloud-aaa';
const TENANT_B_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-jira-oauth-cloud-bbb';

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makeEvent(body: string, signature: string): APIGatewayProxyEvent {
  return {
    body,
    headers: { 'X-Hub-Signature': signature },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/jira/webhook',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function payloadFor(cloudId: string): string {
  return JSON.stringify({
    webhookEvent: 'jira:issue_created',
    timestamp: Date.now(),
    cloudId,
    user: { accountId: 'acc-1' },
    issue: {
      id: '10001',
      key: 'ENG-42',
      fields: { labels: ['bgagent'], project: { id: 'p1', key: 'ENG' } },
    },
  });
}

interface StoredOauthFixture {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly cloud_id: string;
  readonly site_url: string;
  readonly installed_at: string;
  readonly updated_at: string;
  readonly installed_by_platform_user_id: string;
  readonly webhook_signing_secret?: string;
}

function makeStoredOauth(overrides: Partial<StoredOauthFixture> = {}): StoredOauthFixture {
  return {
    access_token: 'jira_at_xxx',
    refresh_token: 'jira_rt_xxx',
    expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    scope: 'read:jira-work write:jira-work read:jira-user',
    client_id: 'cid',
    client_secret: 'csec',
    cloud_id: 'cloud-default',
    site_url: 'https://acme.atlassian.net',
    installed_at: '2026-06-09T08:00:00Z',
    updated_at: '2026-06-09T08:00:00Z',
    installed_by_platform_user_id: 'cog-sub',
    ...overrides,
  };
}

/** Wire the SM mock to respond by SecretId. */
function configureSecretsManager(secrets: Record<string, string | object>) {
  smSend.mockImplementation((cmd: { input: { SecretId: string } }) => {
    const id = cmd.input.SecretId;
    const value = secrets[id];
    if (value === undefined) {
      const err = new Error(`SecretId not mocked: ${id}`);
      (err as Error & { name: string }).name = 'ResourceNotFoundException';
      return Promise.reject(err);
    }
    return Promise.resolve({
      SecretString: typeof value === 'string' ? value : JSON.stringify(value),
    });
  });
}

/** Wire DDB to return registry rows by `jira_cloud_id`. The parser requires
 *  `site_url` + `oauth_secret_arn` — a row missing either is treated as a
 *  registry miss, so the fixture always sets both. */
function configureRegistry(rows: Record<string, { oauth_secret_arn: string; status: string }>) {
  ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Get') {
      const key = cmd.input.Key as { jira_cloud_id?: string } | undefined;
      const cloudId = key?.jira_cloud_id;
      const item = cloudId ? rows[cloudId] : undefined;
      return Promise.resolve(item
        ? { Item: { jira_cloud_id: cloudId, site_url: 'https://acme.atlassian.net', ...item } }
        : { Item: undefined });
    }
    // Dedup Put / rollback Delete — succeed.
    return Promise.resolve({});
  });
}

/** Extract the processor-invoke payload the receiver dispatched. */
function dispatchedPayload(): { raw_body: string; verified_via?: string } {
  expect(lambdaSend).toHaveBeenCalledTimes(1);
  const invoke = lambdaSend.mock.calls[0][0] as { input: { Payload: Uint8Array } };
  return JSON.parse(new TextDecoder().decode(invoke.input.Payload)) as {
    raw_body: string;
    verified_via?: string;
  };
}

describe('jira-webhook handler — per-tenant signature verification', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    lambdaSend.mockReset();
    invalidateJiraSecretCache(process.env.JIRA_WEBHOOK_SECRET_ARN!);
    _resetCachesForTesting();
    lambdaSend.mockResolvedValue({});
  });

  test('verifies tenant A using its per-tenant signing secret and forwards verified_via=per-tenant', async () => {
    configureRegistry({
      [TENANT_A_CLOUD_ID]: { oauth_secret_arn: TENANT_A_SECRET_ARN, status: 'active' },
    });
    configureSecretsManager({
      [TENANT_A_SECRET_ARN]: makeStoredOauth({
        cloud_id: TENANT_A_CLOUD_ID,
        webhook_signing_secret: TENANT_A_SECRET,
      }),
    });
    const body = payloadFor(TENANT_A_CLOUD_ID);
    const result = await handler(makeEvent(body, sign(TENANT_A_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(dispatchedPayload().verified_via).toBe('per-tenant');
  });

  test('verifies tenant B using its DIFFERENT per-tenant signing secret', async () => {
    configureRegistry({
      [TENANT_B_CLOUD_ID]: { oauth_secret_arn: TENANT_B_SECRET_ARN, status: 'active' },
    });
    configureSecretsManager({
      [TENANT_B_SECRET_ARN]: makeStoredOauth({
        cloud_id: TENANT_B_CLOUD_ID,
        webhook_signing_secret: TENANT_B_SECRET,
      }),
    });
    const body = payloadFor(TENANT_B_CLOUD_ID);
    const result = await handler(makeEvent(body, sign(TENANT_B_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  test("rejects tenant A signed with tenant B's secret (per-tenant mismatch is fatal)", async () => {
    // The CRITICAL test: an attacker who learns tenant B's signing secret
    // cannot dispatch as tenant A by claiming A's cloudId. The receiver
    // locks the per-tenant path once it finds A's secret and refuses to
    // fall back to the stack-wide secret.
    configureRegistry({
      [TENANT_A_CLOUD_ID]: { oauth_secret_arn: TENANT_A_SECRET_ARN, status: 'active' },
    });
    configureSecretsManager({
      [TENANT_A_SECRET_ARN]: makeStoredOauth({
        cloud_id: TENANT_A_CLOUD_ID,
        webhook_signing_secret: TENANT_A_SECRET,
      }),
      [process.env.JIRA_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor(TENANT_A_CLOUD_ID);
    const result = await handler(makeEvent(body, sign(TENANT_B_SECRET, body)));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('falls back to stack-wide secret when registry has no row for the cloudId — verified_via=stack-wide', async () => {
    // Back-compat: a tenant onboarded before per-tenant signing has no
    // registry row. The receiver verifies stack-wide and tags the dispatch
    // so the processor treats the body cloudId as untrusted.
    configureRegistry({}); // registry miss
    configureSecretsManager({
      [process.env.JIRA_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor('cloud-not-onboarded');
    const result = await handler(makeEvent(body, sign(STACK_WIDE_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(dispatchedPayload().verified_via).toBe('stack-wide');
  });

  test('falls back to stack-wide secret when per-tenant bundle has no webhook_signing_secret field', async () => {
    // Migration mid-state: tenant registered, but its OAuth bundle has no
    // signing secret yet. Stack-wide remains the source of truth.
    configureRegistry({
      [TENANT_A_CLOUD_ID]: { oauth_secret_arn: TENANT_A_SECRET_ARN, status: 'active' },
    });
    configureSecretsManager({
      [TENANT_A_SECRET_ARN]: makeStoredOauth({
        cloud_id: TENANT_A_CLOUD_ID,
        // No webhook_signing_secret — pre-migration bundle.
      }),
      [process.env.JIRA_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor(TENANT_A_CLOUD_ID);
    const result = await handler(makeEvent(body, sign(STACK_WIDE_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(dispatchedPayload().verified_via).toBe('stack-wide');
  });

  test('rejects when registry status is not active even if per-tenant secret matches', async () => {
    configureRegistry({
      [TENANT_A_CLOUD_ID]: { oauth_secret_arn: TENANT_A_SECRET_ARN, status: 'revoked' },
    });
    configureSecretsManager({
      [TENANT_A_SECRET_ARN]: makeStoredOauth({
        cloud_id: TENANT_A_CLOUD_ID,
        webhook_signing_secret: TENANT_A_SECRET,
      }),
      [process.env.JIRA_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor(TENANT_A_CLOUD_ID);
    const result = await handler(makeEvent(body, sign(TENANT_A_SECRET, body)));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('revoked tenant rejected even when the stack-wide secret matches the request', async () => {
    // Critical security test: if a revoked tenant's old secret equals the
    // stack-wide secret (e.g. it was the first tenant, whose secret seeded
    // the stack-wide fallback), the receiver must NOT silently fall through
    // to stack-wide verification and re-grant access. The distinct
    // `revoked` outcome pins the no-fallback rule.
    configureRegistry({
      [TENANT_A_CLOUD_ID]: { oauth_secret_arn: TENANT_A_SECRET_ARN, status: 'revoked' },
    });
    configureSecretsManager({
      [TENANT_A_SECRET_ARN]: makeStoredOauth({
        cloud_id: TENANT_A_CLOUD_ID,
        webhook_signing_secret: TENANT_A_SECRET,
      }),
      // Stack-wide secret == tenant A's secret (the bypass scenario).
      [process.env.JIRA_WEBHOOK_SECRET_ARN!]: TENANT_A_SECRET,
    });
    const body = payloadFor(TENANT_A_CLOUD_ID);
    const result = await handler(makeEvent(body, sign(TENANT_A_SECRET, body)));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('payload without cloudId skips per-tenant lookup and verifies stack-wide', async () => {
    // Settings-UI webhooks omit cloudId entirely. The receiver can't do a
    // per-tenant lookup, verifies stack-wide, and the processor later binds
    // the delivery to the sole active tenant.
    configureRegistry({
      [TENANT_A_CLOUD_ID]: { oauth_secret_arn: TENANT_A_SECRET_ARN, status: 'active' },
    });
    configureSecretsManager({
      [process.env.JIRA_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      timestamp: Date.now(),
      issue: { id: '10001', key: 'ENG-42', fields: { labels: ['bgagent'], project: { key: 'ENG' } } },
    });
    const result = await handler(makeEvent(body, sign(STACK_WIDE_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(dispatchedPayload().verified_via).toBe('stack-wide');
    // No registry Get should have fired — there was no cloudId to look up.
    expect(ddbSend.mock.calls.every((c) => (c[0] as { _type?: string })._type !== 'Get')).toBe(true);
  });

  test('infra error during per-tenant lookup surfaces as 500 (no silent stack-wide downgrade)', async () => {
    // A DDB throttle on the registry table must NOT collapse to the
    // stack-wide fallback — that would silently downgrade a per-tenant-
    // secured tenant under load. Strict lookups bubble the error so the
    // receiver returns 500 and Atlassian retries.
    ddbSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'Get') {
        const err = new Error('Throttled');
        (err as Error & { name: string }).name = 'ProvisionedThroughputExceededException';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });
    configureSecretsManager({
      [process.env.JIRA_WEBHOOK_SECRET_ARN!]: TENANT_A_SECRET,
    });
    const body = payloadFor(TENANT_A_CLOUD_ID);
    const result = await handler(makeEvent(body, sign(TENANT_A_SECRET, body)));
    expect(result.statusCode).toBe(500);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('missing timestamp skips the replay check but still dispatches (logged bypass)', async () => {
    // Atlassian's documented issue events always carry `timestamp`, but the
    // envelope field is optional. A timestamp-less delivery must not crash
    // or fail verification — it dispatches with the `…#unknown` dedup key.
    configureRegistry({
      [TENANT_A_CLOUD_ID]: { oauth_secret_arn: TENANT_A_SECRET_ARN, status: 'active' },
    });
    configureSecretsManager({
      [TENANT_A_SECRET_ARN]: makeStoredOauth({
        cloud_id: TENANT_A_CLOUD_ID,
        webhook_signing_secret: TENANT_A_SECRET,
      }),
    });
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      cloudId: TENANT_A_CLOUD_ID,
      issue: { id: '10001', key: 'ENG-42', fields: { labels: ['bgagent'], project: { key: 'ENG' } } },
    });
    const result = await handler(makeEvent(body, sign(TENANT_A_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });
});
