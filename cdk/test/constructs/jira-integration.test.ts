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

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { JiraIntegration } from '../../src/constructs/jira-integration';

describe('JiraIntegration construct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });

    new JiraIntegration(stack, 'JiraIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
    });

    template = Template.fromStack(stack);
  });

  test('creates four Jira DynamoDB tables (project mapping + user mapping + workspace registry + dedup)', () => {
    // TaskTable + TaskEventsTable + JiraProjectMapping + JiraUserMapping
    // + JiraWorkspaceRegistry + JiraWebhookDedup = 6
    template.resourceCountIs('AWS::DynamoDB::Table', 6);
  });

  test('project mapping table is keyed on jira_project_identity ({cloudId}#{projectKey})', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'jira_project_identity', KeyType: 'HASH' }],
    });
  });

  test('user mapping table is keyed on jira_identity with a PlatformUserIndex GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'jira_identity', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'PlatformUserIndex' }),
      ]),
    });
  });

  test('workspace registry table is keyed on jira_cloud_id', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'jira_cloud_id', KeyType: 'HASH' }],
    });
  });

  test('creates three Lambda functions (webhook, processor, link)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  test('creates API Gateway resources under /jira', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'jira' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'webhook' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'link' });
  });

  test('creates one Secrets Manager secret (webhook signing) — OAuth tokens are CLI-created at runtime', () => {
    // Per-tenant OAuth tokens live in `bgagent-jira-oauth-<cloudId>` secrets
    // created by `bgagent jira setup`, NOT by CDK. Only the webhook signing
    // secret is CDK-managed.
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('Jira webhook signing secret'),
    });
  });

  test('has NO DynamoDB Streams event-source mapping (outbound is the agent-side REST shim)', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  test('webhook handler env wires dedup table + processor + secret ARN + registry', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          JIRA_WEBHOOK_SECRET_ARN: Match.anyValue(),
          JIRA_WEBHOOK_DEDUP_TABLE_NAME: Match.anyValue(),
          JIRA_WEBHOOK_PROCESSOR_FUNCTION_NAME: Match.anyValue(),
          JIRA_WORKSPACE_REGISTRY_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('processor handler env wires all mapping tables + task table + workspace registry', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          JIRA_PROJECT_MAPPING_TABLE_NAME: Match.anyValue(),
          JIRA_USER_MAPPING_TABLE_NAME: Match.anyValue(),
          JIRA_WORKSPACE_REGISTRY_TABLE_NAME: Match.anyValue(),
          TASK_TABLE_NAME: Match.anyValue(),
          TASK_EVENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('webhook dedup table has TTL attribute', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'dedup_key', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  test('webhook receiver IAM grants are read-only on the per-tenant OAuth secret prefix', () => {
    // The receiver only extracts `webhook_signing_secret` for verification;
    // it must never hold PutSecretValue (the CLI owns secret lifecycle, the
    // processor owns the refresh write-back).
    const policies = template.findResources('AWS::IAM::Policy');
    const receiverPolicies = Object.values(policies).filter((p) => {
      const statements = (p.Properties as {
        PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
      }).PolicyDocument.Statement;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('secretsmanager:GetSecretValue')
          && JSON.stringify(s.Resource).includes('bgagent-jira-oauth-')
          && !actions.includes('secretsmanager:PutSecretValue');
      });
    });
    expect(receiverPolicies.length).toBeGreaterThanOrEqual(1);
  });
});
