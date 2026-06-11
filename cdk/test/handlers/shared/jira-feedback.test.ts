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

const resolveJiraOauthTokenMock = jest.fn();
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOauthToken: (...args: unknown[]) => resolveJiraOauthTokenMock(...args),
}));

const fetchMock = jest.fn();
// `fetch` is a global on Node 24; reassign for test isolation.
(globalThis as unknown as { fetch: jest.Mock }).fetch = fetchMock;

import {
  type JiraFeedbackContext,
  postIssueComment,
  reportIssueFailure,
} from '../../../src/handlers/shared/jira-feedback';

const CTX: JiraFeedbackContext = {
  cloudId: 'cloud-1',
  registryTableName: 'TestJiraWorkspaceRegistry',
};
const ISSUE_KEY = 'ENG-42';
const TOKEN = 'jira_oauth_TESTTOKEN';

function jsonResponse(body: unknown, status: number = 201): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('jira-feedback', () => {
  beforeEach(() => {
    resolveJiraOauthTokenMock.mockReset();
    fetchMock.mockReset();
    resolveJiraOauthTokenMock.mockResolvedValue({
      accessToken: TOKEN,
      scope: 'read:jira-work write:jira-work',
      siteUrl: 'https://acme.atlassian.net',
      oauthSecretArn: 'arn:secret:acme',
    });
    fetchMock.mockResolvedValue(jsonResponse({ id: '12345' }));
  });

  describe('postIssueComment', () => {
    test('POSTs an ADF document body to the REST v3 comment endpoint', async () => {
      const ok = await postIssueComment(CTX, ISSUE_KEY, '❌ blocked');

      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://acme.atlassian.net/rest/api/3/issue/${ISSUE_KEY}/comment`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      });
      // Jira REST v3 400s on non-ADF comment bodies — pin the exact shape.
      const body = JSON.parse(init.body as string) as { body: Record<string, unknown> };
      expect(body.body).toEqual({
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '❌ blocked' }] },
        ],
      });
    });

    test('strips a trailing slash from the stored siteUrl', async () => {
      resolveJiraOauthTokenMock.mockResolvedValue({
        accessToken: TOKEN,
        scope: 'write:jira-work',
        siteUrl: 'https://acme.atlassian.net/',
        oauthSecretArn: 'arn:secret:acme',
      });
      await postIssueComment(CTX, ISSUE_KEY, 'msg');
      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://acme.atlassian.net/rest/api/3/issue/${ISSUE_KEY}/comment`,
      );
    });

    test('URL-encodes the issue key', async () => {
      await postIssueComment(CTX, 'ENG 42/x', 'msg');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://acme.atlassian.net/rest/api/3/issue/ENG%2042%2Fx/comment',
      );
    });

    test('returns false on non-2xx without throwing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ errorMessages: ['nope'] }, 400));
      const ok = await postIssueComment(CTX, ISSUE_KEY, 'msg');
      expect(ok).toBe(false);
    });

    test('returns false on network failure without throwing', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const ok = await postIssueComment(CTX, ISSUE_KEY, 'msg');
      expect(ok).toBe(false);
    });

    test('returns false on request timeout (AbortError) without throwing', async () => {
      const abortErr = new Error('This operation was aborted');
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValue(abortErr);
      const ok = await postIssueComment(CTX, ISSUE_KEY, 'msg');
      expect(ok).toBe(false);
    });

    test('returns false when the tenant token cannot be resolved', async () => {
      resolveJiraOauthTokenMock.mockResolvedValue(null);
      const ok = await postIssueComment(CTX, ISSUE_KEY, 'msg');
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('returns false when the token resolver throws (never propagates)', async () => {
      resolveJiraOauthTokenMock.mockRejectedValue(new Error('DDB throttle'));
      const ok = await postIssueComment(CTX, ISSUE_KEY, 'msg');
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('reportIssueFailure', () => {
    test('posts the message and resolves void on success', async () => {
      await expect(reportIssueFailure(CTX, ISSUE_KEY, '❌ failed')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('never rejects even when everything fails', async () => {
      resolveJiraOauthTokenMock.mockRejectedValue(new Error('boom'));
      await expect(reportIssueFailure(CTX, ISSUE_KEY, '❌ failed')).resolves.toBeUndefined();
    });
  });
});
