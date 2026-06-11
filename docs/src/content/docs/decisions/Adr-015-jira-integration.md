---
title: Adr 015 jira integration
---

# ADR-015: Jira Cloud integration via label trigger, OAuth 3LO, and REST outbound

**Status:** accepted
**Date:** 2026-06-08 (amended 2026-06-11: renumbered from ADR-014 after #296 landed its own ADR-014; outbound pivoted from Atlassian Remote MCP to a REST shim — see "Outbound path" below)

## Context

ABCA ingests coding tasks from CLI, GitHub webhooks, Slack, and Linear, then opens PRs autonomously. Linear was the only issue-tracker channel, but many teams use Jira instead. We want parity: a Jira issue gets a `bgagent` label → ABCA picks it up → an agent run produces a PR → status flows back into the Jira issue.

The Linear integration (`cdk/src/constructs/linear-integration.ts` + sibling handlers + `agent/src/channel_mcp.py`) is the established pattern for an issue-tracker channel, and the forces here are the same: per-tenant credential isolation, webhook authenticity, a low-friction trigger, and an outbound path for the agent to report progress. Jira differs from Linear in a few concrete ways that shape the decision — most notably how label changes and issue descriptions are represented, and how webhook signing secrets are provisioned.

## Decision

Build a **parity-level Jira Cloud integration** that mirrors Linear file-for-file where the shape is the same, and diverges only where Jira's API forces it. Specifically:

- **Jira Cloud only.** Jira Server / Data Center, and Forge/Connect app distribution, are out of scope. The integration targets REST v3 and Atlassian Cloud webhooks.
- **Per-tenant OAuth 3LO**, stored in Secrets Manager as `bgagent-jira-oauth-<cloudId>`, mirroring `bgagent-linear-oauth-<slug>`. `cloudId` (the Atlassian tenant UUID) is the tenant key across all tables and secrets — not the site domain or name.
- **Label trigger** (default `bgagent`), parity with Linear. No status-transition or comment-command triggers in v1.
- **Outbound via the Jira REST v3 API** (`agent/src/jira_reactions.py`): the pipeline posts a "starting" comment when it picks up a Jira-origin task and a terminal "succeeded / failed (+ PR link)" comment at the end, via `POST /rest/api/3/issue/{key}/comment` on the cross-region `api.atlassian.com/ex/jira/{cloudId}` base, authorized by the stored per-tenant OAuth token.
- **Inbound-only adapter.** No DynamoDB Streams consumer and no outbound-notify Lambda, matching Linear's stance.

The channel selection in `agent/src/channel_mcp.py` becomes a small dispatch registry rather than a hardcoded Linear gate, so adding a channel MCP is an entry, not a rewrite. Jira deliberately has **no** entry in that registry (see "Outbound path" below).

### Outbound path: REST shim, not the Atlassian Remote MCP

This ADR originally specified outbound via the **Atlassian Remote MCP server** (`https://mcp.atlassian.com/v1/sse`), with a REST shim noted as Plan B. Implementation falsified the MCP plan: the hosted Remote MCP requires an **interactive, browser-based OAuth 2.1 flow with dynamic client registration** and does not accept the stored Jira REST OAuth token as a `Bearer` header — a headless background agent cannot complete the handshake, and the server fails to connect from the runtime (`claude mcp list` → "Failed to connect"). The Jira REST API accepts the same stored token (it carries `write:jira-work`), so Plan B is the implemented path:

- `agent/src/jira_reactions.py` posts the start/terminal comments (with an auth-failure circuit breaker mirroring `linear_reactions.py`); all errors are advisory — logged and swallowed, never gating the pipeline.
- `agent/src/channel_mcp.py` writes no Jira MCP entry, so Jira tasks don't log a confusing "Failed to connect" on every run.
- Lambda-side pre-container feedback (unmapped project, concurrency cap, guardrail) uses the same REST surface via `cdk/src/handlers/shared/jira-feedback.ts`.

If Atlassian ships a server-to-server auth path for the Remote MCP, the registry entry can be restored and the agent given interactive Jira tools; the REST shim stays regardless as the deterministic pipeline-level fallback.

### Where Jira forced divergence from the Linear copy

These are the points where blindly copying Linear would have been wrong:

1. **Label-add detection on updates.** Jira's `jira:issue_updated` payload reports label changes in `changelog.items[]` (`field: "labels"`, `fromString` / `toString`) — it does *not* re-send the full label list. The processor diffs the changelog, not `issue.fields.labels`, so re-saving an issue that already carries the label does not re-trigger.
2. **Webhook signing secret is operator-chosen.** Atlassian does not auto-generate a per-subscription signing secret the way Linear does. The operator picks one at webhook-create time and pastes it during `bgagent jira setup`; ABCA stores it on the per-tenant OAuth bundle. The stack-wide secret exists only for Settings-UI webhooks (whose payloads omit `cloudId` and can't be verified per-tenant) and is **never mirrored into per-tenant bundles** — a payload verified only by the stack-wide secret carries no binding between the secret and the body's `cloudId`, so the processor refuses a body-supplied `cloudId` on that path and binds the delivery to the sole active tenant instead (dropping it when that's ambiguous).
3. **Signature scheme.** Atlassian signs with HMAC-SHA256 over the *raw* request body, delivered as `X-Hub-Signature: sha256=<hex>`. Verification uses a constant-time compare over the unparsed bytes.
4. **ADF descriptions.** Jira issue descriptions are Atlassian Document Format, not markdown. The processor extracts text/headings/lists into markdown for the task description rather than rolling a full ADF converter.
5. **Dedup key.** `{issueKey}#{webhookEvent}#{timestamp}` with an 8-hour TTL — retries of the same delivery (same queued-at timestamp) collapse, while distinct events (including two label-adds in quick succession, or a created + an updated event in the same millisecond) do not. Jira retries far less aggressively than Linear, so 8 hours is safe parity. Deliveries without a `timestamp` collapse to a single `…#unknown` key per `(issueKey, webhookEvent)` within the TTL window — a deliberate conservative choice, logged at the receiver.

## Consequences

- (+) Teams on Jira Cloud get the same label → PR → progress-comment loop as Linear, with no new operational concepts.
- (+) The REST outbound shim is deterministic and pipeline-owned: comments fire at exactly start/finish, regardless of agent behavior, and there's no dependency on the Atlassian Remote MCP's rollout or auth contract.
- (+) Per-tenant credential isolation and the changelog-diff trigger keep the trust and re-trigger semantics correct for multi-tenant installs.
- (-) Unlike Linear, the agent has no interactive Jira tools mid-run (no issue search, no state transitions) — outbound is limited to the fixed start/terminal comments until a usable MCP auth path ships.
- (-) ADF→markdown is lossy by design (text/headings/lists only); rich content in descriptions is flattened.
- (!) `cloudId` must be used consistently as the tenant key. Indexing on domain or site name anywhere would break tenant resolution.
- (!) The webhook signing secret lives on the per-tenant OAuth bundle; rotating it in Jira without re-running `bgagent jira setup` causes silent 401s on every delivery.
- (!) Settings-UI webhooks (no `cloudId` in payload) only work for single-tenant installs; multi-tenant operators must use webhooks that carry their own `cloudId` (e.g. OAuth-app registered dynamic webhooks).

## References

- Issue: [#288 — Jira Cloud integration (parity with Linear)](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/288)
- [JIRA_SETUP_GUIDE.md](/using/jira-setup-guide) — operational walkthrough
- [LINEAR_SETUP_GUIDE.md](/using/linear-setup-guide) — the analog integration this mirrors
- Reference implementation: `cdk/src/constructs/jira-integration.ts`, `cdk/src/handlers/jira-*.ts`, `agent/src/jira_reactions.py`
