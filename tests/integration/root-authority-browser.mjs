import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";
import { chromium, firefox } from "playwright-core";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { repo, artifacts } = JSON.parse(input);

const now = "2026-11-24T12:00:00.000Z";

let scenario = "root-admin";
let securityRevision = 5;
let triggerNextGrantConflict = false;
let grantSeq = 1;

const grants = [
  {
    id: "rgr_existing_1",
    subject: { type: "agent", id: "agt_root_worker" },
    generation: 2,
    scope: "system",
    status: "active",
    effective: true,
    effective_reason_code: "effective",
    authority_node_id: "auth_node_existing_1",
    issuer: { type: "user", id: "usr_root_human" },
    origin_attempt_id: null,
    origin_family_id: "fam_root_human",
    reason: "Bootstrap isolated fixture grant",
    revocation_reason: null,
    created_at: now,
    expires_at: null,
    revoked_at: null,
    revision: 5,
    runtime_trust_ids: ["rtr_trusted_1"],
  },
];

const trusts = [
  {
    id: "rtr_trusted_1",
    generation: 1,
    runtime_id: "rt_trusted_1",
    daemon_id: "dmn_trusted_1",
    incarnation: "inc_trusted_1",
    workspace_id: "ws_root_smoke",
    recipient_key_id: "rkey_trusted_1",
    recipient_key_fingerprint: "sha256:trusted1",
    recipient_key_expires_at: null,
    immutable_env_carrier_verified: true,
    isolation_note: "Isolated dedicated fixture host",
    status: "active",
    effective: true,
    effective_reason_code: "effective",
    issuer: { type: "user", id: "usr_root_human" },
    reason: "Fixture trust baseline",
    revocation_reason: null,
    expires_at: null,
    created_at: now,
    revoked_at: null,
    revision: 5,
  },
];

const auditEntries = [
  {
    id: "raud_1",
    action: "root_grant.create",
    outcome: "allowed",
    actor: { type: "user", id: "usr_root_human" },
    credential_id: "cred_human_1",
    family_id: "fam_root_human",
    origin_attempt_id: null,
    grant_id: "rgr_existing_1",
    grant_generation: 2,
    target_type: "root_grant",
    target_id: "rgr_existing_1",
    scope: "system",
    before_revision: 4,
    after_revision: 5,
    reason_code: "effective",
    reason: "Bootstrap isolated fixture grant",
    cleanup_batch_id: null,
    created_at: now,
  },
];

const tokens = [
  {
    id: "pat_human_1",
    name: "Operator CLI Token",
    token_prefix: "rem_hum1",
    created_at: now,
    last_used_at: now,
    expires_at: null,
    family_id: "fam_human_1",
    origin_attempt_id: null,
    authenticated_subject: { type: "user", id: "usr_root_human" },
    beneficiary_user_id: "usr_root_human",
    is_agent_origin: false,
  },
  {
    id: "pat_agent_1",
    name: "Root Worker Task Token",
    token_prefix: "rem_agt1",
    created_at: now,
    last_used_at: now,
    expires_at: null,
    family_id: "fam_agent_1",
    origin_attempt_id: "att_old_1",
    authenticated_subject: { type: "agent", id: "agt_root_worker" },
    beneficiary_user_id: "usr_root_human",
    is_agent_origin: true,
  },
];

const requests = [];
const unknownRequests = [];

function currentRootContext() {
  if (scenario === "non-root-member") {
    return {
      security_revision: securityRevision,
      feature_activation: true,
      bootstrap_completed: true,
      transport_identity: "human_session",
      authenticated_subject: { type: "user", id: "usr_owner_non_root" },
      beneficiary_user_id: "usr_owner_non_root",
      is_agent_origin: false,
      credential_id: "cred_owner_1",
      family_id: "fam_owner_1",
      origin_attempt_id: null,
      current_attempt_id: null,
      agent_granted_root: false,
      current_attempt_effective_root: false,
      effective_root: false,
      effective_reason_code: "no_grant",
      grant_id: null,
      grant_generation: null,
      capabilities: {
        can_manage_root: false,
        can_manage_runtime_trust: false,
        can_revoke_credential_family: false,
        can_read_root_audit: false,
        can_edit_root_execution: false,
      },
      allowed_operations: [],
    };
  }
  if (scenario === "agent-origin-ineffective") {
    return {
      security_revision: securityRevision,
      feature_activation: true,
      bootstrap_completed: true,
      transport_identity: "pat",
      authenticated_subject: { type: "agent", id: "agt_root_worker" },
      beneficiary_user_id: "usr_root_human",
      is_agent_origin: true,
      credential_id: "pat_agent_1",
      family_id: "fam_agent_1",
      origin_attempt_id: "att_old_1",
      current_attempt_id: "att_old_1",
      agent_granted_root: true,
      current_attempt_effective_root: false,
      effective_root: false,
      effective_reason_code: "attempt_not_eligible",
      grant_id: "rgr_existing_1",
      grant_generation: 2,
      capabilities: {
        can_manage_root: false,
        can_manage_runtime_trust: false,
        can_revoke_credential_family: false,
        can_read_root_audit: true,
        can_edit_root_execution: false,
      },
      allowed_operations: ["root.audit.read"],
    };
  }
  return {
    security_revision: securityRevision,
    feature_activation: true,
    bootstrap_completed: true,
    transport_identity: "human_session",
    authenticated_subject: { type: "user", id: "usr_root_human" },
    beneficiary_user_id: "usr_root_human",
    is_agent_origin: false,
    credential_id: "cred_human_1",
    family_id: "fam_root_human",
    origin_attempt_id: null,
    current_attempt_id: null,
    agent_granted_root: false,
    current_attempt_effective_root: false,
    effective_root: true,
    effective_reason_code: "effective",
    grant_id: "rgr_human_root",
    grant_generation: 1,
    capabilities: {
      can_manage_root: true,
      can_manage_runtime_trust: true,
      can_revoke_credential_family: true,
      can_read_root_audit: true,
      can_edit_root_execution: true,
    },
    allowed_operations: [
      "root.grant.manage",
      "root.runtime_trust.manage",
      "root.credential_family.revoke",
      "root.audit.read",
      "root.execution.edit",
    ],
  };
}

async function fixtureApi(req, res, next) {
  const url = new URL(req.url, "http://fixture.test");
  const path = url.pathname;
  if (!path.startsWith("/api/")) return next();

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    let source = "";
    for await (const chunk of req) source += chunk;
    body = source ? JSON.parse(source) : undefined;
  }

  const record = {
    method: req.method,
    path,
    status: 200,
    body,
    idempotencyKey: req.headers["idempotency-key"] ?? null,
  };
  requests.push(record);

  const send = (value, status = 200) => {
    record.status = status;
    res.statusCode = status;
    if (status === 204) return res.end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };

  if (path === "/api/workspaces") {
    return send([{ id: "ws_root_smoke", slug: "root-smoke", name: "Root Smoke Workspace" }]);
  }
  if (path === "/api/workspaces/ws_root_smoke/members") {
    return send([
      {
        id: "mem_local_owner",
        workspace_id: "ws_root_smoke",
        user_id: "local",
        role: "owner",
        name: "Workspace Owner",
        email: "owner@example.test",
        avatar_url: null,
        created_at: now,
      },
      {
        id: "mem_owner_non_root",
        workspace_id: "ws_root_smoke",
        user_id: "usr_owner_non_root",
        role: "owner",
        name: "Workspace Owner",
        email: "owner@example.test",
        avatar_url: null,
        created_at: now,
      },
      {
        id: "mem_root_human",
        workspace_id: "ws_root_smoke",
        user_id: "usr_root_human",
        role: "owner",
        name: "Root Operator",
        email: "root@example.test",
        avatar_url: null,
        created_at: now,
      },
    ]);
  }
  if (path === "/api/multiremi/platform/status" && req.method === "GET") {
    return send({ canManage: false }, 403);
  }
  if (path === "/api/tokens" && req.method === "GET") {
    return send(tokens);
  }
  if (path === "/api/root/context" && req.method === "GET") {
    if (scenario === "capability-unavailable") {
      return send(
        {
          error: {
            code: "security_state_unavailable",
            message: "Root security state is temporarily unavailable.",
            retryable: true,
            requestId: "req_unavailable_1",
          },
        },
        503,
      );
    }
    return send(currentRootContext());
  }
  if (path === "/api/root/grants" && req.method === "GET") {
    return send({ security_revision: securityRevision, grants, next_cursor: null });
  }
  if (path === "/api/root/grants" && req.method === "POST") {
    assert.equal(typeof body.idempotency_key, "string", "Grant create must send idempotency_key");
    assert.equal(req.headers["idempotency-key"], body.idempotency_key, "Header Idempotency-Key must match body");
    if (triggerNextGrantConflict) {
      triggerNextGrantConflict = false;
      securityRevision = 8;
      return send(
        {
          error: {
            code: "authority_revision_conflict",
            message: "Security revision advanced; refresh and retry.",
            retryable: true,
            requestId: "req_conflict_1",
            currentRevision: securityRevision,
          },
        },
        409,
      );
    }
    assert.equal(body.expected_revision, securityRevision, "Grant create must send current expected_revision");
    securityRevision += 1;
    const created = {
      id: `rgr_created_${++grantSeq}`,
      subject: body.subject,
      generation: 1,
      scope: "system",
      status: "active",
      effective: true,
      effective_reason_code: "effective",
      authority_node_id: `auth_node_created_${grantSeq}`,
      issuer: { type: "user", id: "usr_root_human" },
      origin_attempt_id: null,
      origin_family_id: "fam_root_human",
      reason: body.reason,
      revocation_reason: null,
      created_at: now,
      expires_at: body.expires_at ?? null,
      revoked_at: null,
      revision: securityRevision,
      runtime_trust_ids: body.runtime_trust_ids ?? [],
    };
    grants.push(created);
    auditEntries.unshift({
      id: `raud_${auditEntries.length + 1}`,
      action: "root_grant.create",
      outcome: "allowed",
      actor: { type: "user", id: "usr_root_human" },
      credential_id: "cred_human_1",
      family_id: "fam_root_human",
      origin_attempt_id: null,
      grant_id: created.id,
      grant_generation: 1,
      target_type: "root_grant",
      target_id: created.id,
      scope: "system",
      before_revision: securityRevision - 1,
      after_revision: securityRevision,
      reason_code: "effective",
      reason: body.reason,
      cleanup_batch_id: null,
      created_at: now,
    });
    return send({ security_revision: securityRevision, grant: created, replayed: false }, 201);
  }
  const revokeGrantMatch = path.match(/^\/api\/root\/grants\/([^/]+)\/revoke$/);
  if (revokeGrantMatch && req.method === "POST") {
    const grantId = revokeGrantMatch[1];
    assert.equal(typeof body.idempotency_key, "string", "Grant revoke must send idempotency_key");
    assert.equal(req.headers["idempotency-key"], body.idempotency_key, "Header Idempotency-Key must match body");
    assert.equal(body.expected_revision, securityRevision, "Grant revoke must send current expected_revision");
    const target = grants.find((g) => g.id === grantId);
    assert(target, `Grant ${grantId} must exist`);
    securityRevision += 1;
    target.status = "revoked";
    target.effective = false;
    target.effective_reason_code = "grant_revoked";
    target.revoked_at = now;
    target.revocation_reason = body.reason;
    target.revision = securityRevision;
    return send({
      security_revision: securityRevision,
      grant: target,
      affected_authority_count: 2,
      cleanup_batch_id: "cb_revoke_1",
      replayed: false,
      last_root_revoked: true,
      exposed_external_secrets_requiring_rotation: [
        {
          target_type: "external_api_key",
          target_id: "ext_secret_ci_deploy",
          secret_version: "v3",
          accessed_at: now,
          rotation_required: true,
          note: "Rotate out-of-band CI deploy key",
        },
      ],
    });
  }
  if (path === "/api/root/runtime-trust" && req.method === "GET") {
    return send({ security_revision: securityRevision, trusts, next_cursor: null });
  }
  const revokeFamilyMatch = path.match(/^\/api\/root\/credential-families\/([^/]+)\/revoke$/);
  if (revokeFamilyMatch && req.method === "POST") {
    assert.equal(typeof body.idempotency_key, "string", "Family revoke must send idempotency_key");
    assert.equal(req.headers["idempotency-key"], body.idempotency_key, "Header Idempotency-Key must match body");
    assert.equal(body.expected_revision, securityRevision, "Family revoke must send current expected_revision");
    securityRevision += 1;
    return send({
      security_revision: securityRevision,
      family_id: revokeFamilyMatch[1],
      status: "revoked",
      affected_authority_count: 3,
      cleanup_batch_id: "cb_family_1",
      replayed: false,
    });
  }
  if (path === "/api/root/audit" && req.method === "GET") {
    return send({ security_revision: securityRevision, entries: auditEntries, next_cursor: null });
  }

  unknownRequests.push({ method: req.method, path });
  return send({ error: "Unknown fixture request: " + path }, 404);
}

async function launchBrowser() {
  if (process.env.CHROME_EXECUTABLE && existsSync(process.env.CHROME_EXECUTABLE)) {
    return {
      engine: "chromium",
      browser: await chromium.launch({
        headless: true,
        executablePath: process.env.CHROME_EXECUTABLE,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }),
    };
  }
  if (chromium.executablePath() && existsSync(chromium.executablePath())) {
    return {
      engine: "chromium",
      browser: await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }),
    };
  }
  const firefoxExe = process.env.FIREFOX_EXECUTABLE || firefox.executablePath();
  assert(firefoxExe && existsSync(firefoxExe), "Neither Playwright Chromium nor Playwright Firefox is installed");
  return {
    engine: "firefox",
    browser: await firefox.launch({
      headless: true,
      executablePath: firefoxExe,
    }),
  };
}

const server = await createServer({
  configFile: false,
  root: join(repo, "frontend/tests/root-authority"),
  cacheDir: join(artifacts, "vite-cache"),
  css: { postcss: { plugins: [tailwind()] } },
  plugins: [
    react(),
    {
      name: "isolated-root-authority-api",
      configureServer(viteServer) {
        viteServer.middlewares.use((...args) => {
          void fixtureApi(...args).catch((error) => {
            args[1].statusCode = 500;
            args[1].end(String(error));
          });
        });
      },
    },
  ],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
});

let browser;
let engine = "unknown";
let currentPage;
const checks = [];
const pageErrors = [];
const consoleWarnings = [];
const consoleErrors = [];
const failedRequests = [];
let failure;

try {
  await server.listen();
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const launched = await launchBrowser();
  browser = launched.browser;
  engine = launched.engine;

  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  currentPage = page;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "warning") consoleWarnings.push(msg.text());
    if (type === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push({
      method: req.method(),
      url: req.url(),
      failureText: req.failure()?.errorText ?? "unknown",
    });
  });

  // 1. Capability unavailable (503 on /api/root/context): ?tab=root falls back to Profile, Root Authority tab stays hidden, protected root Agent stays read-only
  scenario = "capability-unavailable";
  const unavailableContextResponse = page.waitForResponse(
    (resp) => resp.request().method() === "GET" && new URL(resp.url()).pathname === "/api/root/context",
  );
  await page.goto(`${origin}/?surface=capability-unavailable&tab=root`, { waitUntil: "networkidle" });
  assert.equal((await unavailableContextResponse).status(), 503);
  await page.getByTestId("account-real-user-id").waitFor({ timeout: 30_000 });
  assert.equal(await page.getByRole("tab", { name: "Profile" }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("tab", { name: "Root Authority" }).count(), 0, "Unavailable root context must hide Root Authority tab");
  await page.screenshot({ path: join(artifacts, "capability-unavailable.png"), fullPage: true });
  await page.goto(`${origin}/?surface=protected-agent`, { waitUntil: "networkidle" });
  await page.getByTestId("protected-agent-surface").waitFor({ timeout: 30_000 });
  await page.getByText("Protected root agent — only an explicit system root operator can edit its execution configuration.", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("agent-edit-button").isDisabled(), true, "Unavailable root context must keep protected root Agent edit disabled");
  checks.push("503 root context falls closed: ?tab=root falls back to Profile, hides Root Authority tab, and keeps protected root Agent read-only");

  // 2. Non-root workspace owner: Settings hides Root Authority tab; protected root Agent is read-only for authenticated local owner
  scenario = "non-root-member";
  await page.goto(`${origin}/?surface=non-root-member&tab=profile`, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="account-real-user-id"]')?.textContent?.trim() === "user:usr_owner_non_root",
    undefined,
    { timeout: 30_000 },
  );
  assert.equal(await page.getByRole("searchbox").inputValue(), "Workspace Owner");
  assert.equal(await page.getByRole("tab", { name: "Root Authority" }).count(), 0, "Non-root user must not see Root Authority tab");
  checks.push("Non-root human user sees Profile identity and cannot see Root Authority management tab");

  await page.goto(`${origin}/?surface=protected-agent`, { waitUntil: "networkidle" });
  await page.getByTestId("protected-agent-surface").waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId("agent-role-badge").textContent(), "normal");
  const badges = page.getByTestId("agent-root-badge");
  assert.equal(await badges.count(), 2);
  assert.equal(await badges.nth(0).getAttribute("data-root-effective"), "true");
  assert.equal(await badges.nth(1).getAttribute("data-root-effective"), "false");
  assert.equal(await badges.nth(1).getAttribute("data-root-reason"), "attempt_not_eligible");
  await page.getByText("Protected root agent — only an explicit system root operator can edit its execution configuration.", { exact: false }).waitFor();
  assert.equal(await page.getByText("Sign in to edit this agent.", { exact: false }).count(), 0, "Authenticated local workspace owner must hit root_execution_protected, not not_authenticated");
  assert.equal(await page.getByTestId("agent-edit-button").isDisabled(), true, "Non-root workspace owner must not edit a protected root Agent");
  await page.screenshot({ path: join(artifacts, "non-root-protected-agent.png"), fullPage: true });
  checks.push("Protected root Agent shows orthogonal role + effective/ineffective badges and blocks ordinary workspace owner edits with root_execution_protected");

  // 3. Explicit root human operator: view context, grant root, handle 409 conflict + reload, revoke grant with rotation/last-root notices, revoke family
  scenario = "root-admin";
  await page.goto(`${origin}/?surface=root-admin&tab=profile`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Root Authority" }).waitFor({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Root Authority" }).click();
  await page.getByTestId("root-authority-tab").waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(await page.getByTestId("root-authenticated-subject").textContent(), "user:usr_root_human");
  assert.match((await page.getByTestId("root-security-revision").textContent()) ?? "", /rev 5/);
  assert.match((await page.getByTestId("root-granted-vs-effective").textContent()) ?? "", /Effective system root active/);
  await page.getByText("rt_trusted_1", { exact: true }).waitFor();
  await page.getByText("root_grant.create", { exact: true }).first().waitFor();
  checks.push("Explicit root operator sees real subject, revision, effective status, trusted runtime, and audit entries");

  // Grant root to a new agent (verifying empty-reason guard + expected_revision + Idempotency-Key)
  const grantSubmitBtn = page.getByRole("button", { name: "Grant system root", exact: true });
  const grantSubjectInput = page.getByPlaceholder("agt_...");
  const grantReasonInput = page.getByPlaceholder("Why this subject requires explicit system root authority");
  await grantSubjectInput.fill("agt_worker_2");
  assert.equal(await grantSubmitBtn.isDisabled(), true, "Grant submit must stay disabled when audit reason is empty");
  await grantReasonInput.fill("Browser smoke isolated grant");
  assert.equal(await grantSubmitBtn.isDisabled(), false, "Grant submit must enable once subject and reason are filled");
  const grantCreateResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/root/grants",
  );
  await grantSubmitBtn.click();
  assert.equal((await grantCreateResponse).status(), 201);
  const createReq = requests.findLast((r) => r.method === "POST" && r.path === "/api/root/grants");
  assert.equal(createReq?.body?.expected_revision, 5);
  assert.deepEqual(createReq?.body?.subject, { type: "agent", id: "agt_worker_2" });
  assert.equal(createReq?.body?.reason, "Browser smoke isolated grant");
  assert.equal(createReq?.idempotencyKey, createReq?.body?.idempotency_key);
  await page.getByText("agent:agt_worker_2", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="root-security-revision"]')?.textContent?.includes("rev 6"),
  );
  checks.push("Root operator creates an explicit system root grant with empty-reason guard, expected_revision, and matching Idempotency-Key");

  // Trigger 409 authority_revision_conflict (public camelCase envelope) and click Reload latest
  triggerNextGrantConflict = true;
  await grantSubjectInput.fill("agt_conflict_target");
  await grantReasonInput.fill("Trigger stale revision");
  const conflictResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/root/grants",
  );
  await grantSubmitBtn.click();
  assert.equal((await conflictResponse).status(), 409);
  await page.getByTestId("root-revision-conflict-banner").waitFor();
  assert.match((await page.getByTestId("root-revision-conflict-banner").textContent()) ?? "", /8/);
  await page.screenshot({ path: join(artifacts, "root-admin-grants-and-conflict.png"), fullPage: true });
  await page.getByRole("button", { name: "Reload latest", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="root-security-revision"]')?.textContent?.includes("rev 8"),
  );
  assert.equal(await page.getByTestId("root-revision-conflict-banner").count(), 0);
  await page.waitForLoadState("networkidle");
  checks.push("409 authority_revision_conflict displays current revision banner and reloads cleanly via Reload latest");

  // Revoke active grant and inspect exposed_external_secrets_requiring_rotation + last_root_revoked warnings
  await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
  const revokeDialog = page.getByRole("alertdialog");
  await revokeDialog.waitFor();
  assert.match((await revokeDialog.textContent()) ?? "", /Revoke system root grant\?/);
  const confirmRevokeBtn = revokeDialog.getByRole("button", { name: "Revoke", exact: true });
  assert.equal(await confirmRevokeBtn.isDisabled(), true, "Revoke confirm must stay disabled when reason is empty");
  await revokeDialog.getByPlaceholder("Non-secret audit reason for revocation").fill("Browser smoke revocation");
  assert.equal(await confirmRevokeBtn.isDisabled(), false);
  const revokeResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname.endsWith("/revoke"),
  );
  await confirmRevokeBtn.click();
  assert.equal((await revokeResponse).status(), 200);
  const revokeGrantReq = requests.findLast((r) => r.method === "POST" && /^\/api\/root\/grants\/[^/]+\/revoke$/.test(r.path));
  assert.equal(revokeGrantReq?.body?.expected_revision, 8);
  assert.equal(revokeGrantReq?.body?.reason_code, "grant_revoked");
  assert.equal(revokeGrantReq?.body?.reason, "Browser smoke revocation");
  await revokeDialog.waitFor({ state: "hidden" });
  await page.getByTestId("root-last-revoked-warning").waitFor();
  await page.getByTestId("root-exposed-secrets-notice").waitFor();
  assert.match((await page.getByTestId("root-exposed-secrets-notice").textContent()) ?? "", /ext_secret_ci_deploy/);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="root-security-revision"]')?.textContent?.includes("rev 9"),
  );
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(artifacts, "root-admin-revoked-warnings.png"), fullPage: true });
  checks.push("Revoking root grant enforces reason, sends expected_revision/grant_revoked, and surfaces last_root_revoked + external secret rotation notice");

  // Revoke credential family
  const familySubmitBtn = page.getByRole("button", { name: "Revoke credential family", exact: true });
  await page.getByPlaceholder("fam_...").fill("fam_compromised_1");
  assert.equal(await familySubmitBtn.isDisabled(), true, "Family revoke must stay disabled when reason is empty");
  await page.getByPlaceholder("Reason for revoking this credential family").fill("Browser smoke incident containment");
  assert.equal(await familySubmitBtn.isDisabled(), false);
  const familyResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/root/credential-families/fam_compromised_1/revoke",
  );
  await familySubmitBtn.click();
  assert.equal((await familyResponse).status(), 200);
  const familyReq = requests.findLast((r) => r.method === "POST" && r.path === "/api/root/credential-families/fam_compromised_1/revoke");
  assert.equal(familyReq?.body?.expected_revision, 9);
  assert.equal(familyReq?.body?.reason_code, "operator_security_revoke");
  assert.equal(familyReq?.body?.reason, "Browser smoke incident containment");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="root-security-revision"]')?.textContent?.includes("rev 10"),
  );
  await page.waitForLoadState("networkidle");
  checks.push("Credential family security revocation enforces reason and submits expected_revision + operator_security_revoke");

  // 4. Agent-origin PAT context: never disguised as real human; distinguishes granted vs attempt-ineffective
  scenario = "agent-origin-ineffective";
  await page.goto(`${origin}/?surface=agent-origin-ineffective&tab=profile`, { waitUntil: "networkidle" });
  await page.getByTestId("account-agent-origin-notice").waitFor({ timeout: 30_000 });
  assert.match((await page.getByTestId("account-agent-origin-notice").textContent()) ?? "", /Agent-origin credential/i);
  assert.equal(await page.getByTestId("account-real-user-id").textContent(), "agent:agt_root_worker");
  await page.getByRole("tab", { name: "API Tokens" }).click();
  await page.getByTestId("token-agent-origin-badge").waitFor();
  await page.getByText("family fam_agent_1", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "Root Authority" }).click();
  await page.getByTestId("root-authority-tab").waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(await page.getByTestId("root-authenticated-subject").textContent(), "agent:agt_root_worker");
  await page.getByTestId("root-agent-origin-badge").waitFor();
  assert.match((await page.getByTestId("root-granted-vs-effective").textContent()) ?? "", /attempt_not_eligible/);
  await page.screenshot({ path: join(artifacts, "agent-origin-provenance.png"), fullPage: true });
  checks.push("Agent-origin PAT is explicitly labeled across Account, Tokens, and Root tabs and distinguishes granted vs attempt-ineffective");

  assert.deepEqual(pageErrors, [], "Browser runtime errors");
  assert.deepEqual(consoleErrors, [], "Browser console errors");
  assert.deepEqual(unknownRequests, [], "Fixture must explicitly cover every requested API");
  await context.close();
} catch (error) {
  failure = String(error);
  console.error(error);
  if (currentPage) {
    await currentPage.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
    writeFileSync(join(artifacts, "failure.html"), await currentPage.content().catch(() => ""));
  }
} finally {
  writeFileSync(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        passed: !failure,
        fixture: "real React/Vite/Playwright browser with isolated HTTP fixture (no real server/DB/root grant)",
        engine,
        browser: browser?.version(),
        checks,
        requestCount: requests.length,
        unknownRequests,
        pageErrors,
        consoleWarnings,
        consoleErrors,
        failedRequests,
        failure,
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await server.close();
}

console.log(`${checks.length} real browser checks completed (${engine} ${browser?.version() ?? "n/a"}); artifacts: ${artifacts}`);
process.exit(failure ? 1 : 0);
