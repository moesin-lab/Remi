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
    status: "active",
    effective: true,
    effective_reason_code: "effective",
    issuer: { type: "user", id: "usr_root_human" },
    reason: "Bootstrap isolated fixture grant",
    created_at: now,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason_code: null,
    revoke_reason: null,
    runtime_trust_ids: ["rtr_trusted_1"],
  },
];

const trusts = [
  {
    id: "rtr_trusted_1",
    runtime_id: "rt_trusted_1",
    daemon_id: "dmn_trusted_1",
    incarnation: "inc_trusted_1",
    generation: 1,
    status: "active",
    recipient_key_id: "rkey_trusted_1",
    recipient_key_fingerprint: "sha256:trusted1",
    immutable_env_carrier_verified: true,
    isolation_note: "Isolated dedicated fixture host",
    reason: "Fixture trust baseline",
    granted_by: { type: "user", id: "usr_root_human" },
    created_at: now,
    revoked_at: null,
    revoked_by: null,
    revoke_reason_code: null,
    revoke_reason: null,
  },
];

const auditEntries = [
  {
    id: "raud_1",
    action: "root_grant.create",
    outcome: "allowed",
    actor: { type: "user", id: "usr_root_human" },
    actor_is_agent_origin: false,
    target_type: "root_grant",
    target_id: "rgr_existing_1",
    before_revision: 4,
    after_revision: 5,
    reason_code: "effective",
    reason: "Bootstrap isolated fixture grant",
    request_id: "req_fixture_boot",
    idempotency_key: "idem_boot_1",
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
      authenticated_subject: { type: "user", id: "usr_owner_non_root" },
      beneficiary_user_id: "usr_owner_non_root",
      is_agent_origin: false,
      transport_identity: "human_session",
      family_id: "fam_owner_1",
      origin_attempt_id: null,
      security_revision: securityRevision,
      root_granted: false,
      effective_root: false,
      effective_reason_code: "no_grant",
      grant_id: null,
      grant_generation: null,
      agent_granted_root: false,
      current_attempt_effective_root: false,
      capabilities: {
        can_manage_root: false,
        can_manage_runtime_trust: false,
        can_revoke_credential_family: false,
        can_read_root_audit: false,
        can_edit_root_execution: false,
      },
    };
  }
  if (scenario === "agent-origin-ineffective") {
    return {
      authenticated_subject: { type: "agent", id: "agt_root_worker" },
      beneficiary_user_id: "usr_root_human",
      is_agent_origin: true,
      transport_identity: "pat",
      family_id: "fam_agent_1",
      origin_attempt_id: "att_old_1",
      security_revision: securityRevision,
      root_granted: true,
      effective_root: false,
      effective_reason_code: "attempt_not_eligible",
      grant_id: "rgr_existing_1",
      grant_generation: 2,
      agent_granted_root: true,
      current_attempt_effective_root: false,
      capabilities: {
        can_manage_root: false,
        can_manage_runtime_trust: false,
        can_revoke_credential_family: false,
        can_read_root_audit: true,
        can_edit_root_execution: false,
      },
    };
  }
  return {
    authenticated_subject: { type: "user", id: "usr_root_human" },
    beneficiary_user_id: "usr_root_human",
    is_agent_origin: false,
    transport_identity: "human_session",
    family_id: "fam_root_human",
    origin_attempt_id: null,
    security_revision: securityRevision,
    root_granted: true,
    effective_root: true,
    effective_reason_code: "effective",
    grant_id: "rgr_human_root",
    grant_generation: 1,
    agent_granted_root: false,
    current_attempt_effective_root: false,
    capabilities: {
      can_manage_root: true,
      can_manage_runtime_trust: true,
      can_revoke_credential_family: true,
      can_read_root_audit: true,
      can_edit_root_execution: true,
    },
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
  requests.push({
    method: req.method,
    path,
    body,
    idempotencyKey: req.headers["idempotency-key"] ?? null,
  });

  const send = (value, status = 200) => {
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
        id: "mem_owner_non_root",
        user_id: "usr_owner_non_root",
        role: "owner",
        name: "Workspace Owner",
      },
      {
        id: "mem_root_human",
        user_id: "usr_root_human",
        role: "owner",
        name: "Root Operator",
      },
    ]);
  }
  if (path === "/api/platform/status") {
    return send({ canManage: false }, 403);
  }
  if (path === "/api/auth/tokens" && req.method === "GET") {
    return send(tokens);
  }
  if (path === "/api/root/context" && req.method === "GET") {
    return send(currentRootContext());
  }
  if (path === "/api/root/grants" && req.method === "GET") {
    return send({ security_revision: securityRevision, grants });
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
            request_id: "req_conflict_1",
            current_revision: securityRevision,
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
      status: "active",
      effective: true,
      effective_reason_code: "effective",
      issuer: { type: "user", id: "usr_root_human" },
      reason: body.reason,
      created_at: now,
      expires_at: body.expires_at ?? null,
      revoked_at: null,
      revoked_by: null,
      revoke_reason_code: null,
      revoke_reason: null,
      runtime_trust_ids: body.runtime_trust_ids ?? [],
    };
    grants.push(created);
    auditEntries.unshift({
      id: `raud_${auditEntries.length + 1}`,
      action: "root_grant.create",
      outcome: "allowed",
      actor: { type: "user", id: "usr_root_human" },
      actor_is_agent_origin: false,
      target_type: "root_grant",
      target_id: created.id,
      before_revision: securityRevision - 1,
      after_revision: securityRevision,
      reason_code: "effective",
      reason: body.reason,
      request_id: "req_grant_create",
      idempotency_key: body.idempotency_key,
      created_at: now,
    });
    return send({ security_revision: securityRevision, grant: created, replayed: false }, 201);
  }
  const revokeGrantMatch = path.match(/^\/api\/root\/grants\/([^/]+)\/revoke$/);
  if (revokeGrantMatch && req.method === "POST") {
    const grantId = revokeGrantMatch[1];
    assert.equal(body.expected_revision, securityRevision, "Grant revoke must send current expected_revision");
    const target = grants.find((g) => g.id === grantId);
    assert(target, `Grant ${grantId} must exist`);
    securityRevision += 1;
    target.status = "revoked";
    target.effective = false;
    target.effective_reason_code = "grant_revoked";
    target.revoked_at = now;
    target.revoked_by = { type: "user", id: "usr_root_human" };
    target.revoke_reason_code = body.reason_code ?? "grant_revoked";
    target.revoke_reason = body.reason;
    return send({
      security_revision: securityRevision,
      grant: target,
      affected_authority_count: 2,
      replayed: false,
      last_root_revoked: true,
      exposed_external_secrets_requiring_rotation: [
        {
          target_type: "external_api_key",
          target_id: "ext_secret_ci_deploy",
          secret_version: "v3",
          note: "Rotate out-of-band CI deploy key",
        },
      ],
    });
  }
  if (path === "/api/root/runtime-trust" && req.method === "GET") {
    return send({ security_revision: securityRevision, trusts });
  }
  const revokeFamilyMatch = path.match(/^\/api\/root\/credential-families\/([^/]+)\/revoke$/);
  if (revokeFamilyMatch && req.method === "POST") {
    assert.equal(body.expected_revision, securityRevision, "Family revoke must send current expected_revision");
    securityRevision += 1;
    return send({
      security_revision: securityRevision,
      family_id: revokeFamilyMatch[1],
      revoked_at: now,
      reason_code: body.reason_code,
      affected_authority_count: 3,
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

  // 1. Non-root workspace owner: Settings hides Root Authority tab; protected root Agent is read-only
  scenario = "non-root-member";
  await page.goto(`${origin}/?surface=non-root-member&tab=profile`);
  await page.waitForSelector("#root > *", { timeout: 30_000 });
  await page.getByText("Workspace Owner", { exact: false }).first().waitFor();
  assert.equal(await page.getByRole("tab", { name: "Root Authority" }).count(), 0, "Non-root user must not see Root Authority tab");
  checks.push("Non-root human user cannot see Root Authority management tab");

  await page.goto(`${origin}/?surface=protected-agent`);
  await page.getByTestId("protected-agent-surface").waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId("agent-role-badge").textContent(), "normal");
  const badges = page.getByTestId("agent-root-badge");
  assert.equal(await badges.count(), 2);
  assert.equal(await badges.nth(0).getAttribute("data-root-effective"), "true");
  assert.equal(await badges.nth(1).getAttribute("data-root-effective"), "false");
  assert.equal(await badges.nth(1).getAttribute("data-root-reason"), "attempt_not_eligible");
  await page.getByText("Protected system root Agent", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("agent-edit-button").isDisabled(), true, "Non-root workspace owner must not edit a protected root Agent");
  await page.screenshot({ path: join(artifacts, "non-root-protected-agent.png"), fullPage: true });
  checks.push("Protected root Agent shows orthogonal role + effective/ineffective badges and blocks ordinary workspace owner edits");

  // 2. Explicit root human operator: view context, grant root, handle 409 conflict + reload, revoke grant with rotation/last-root notices, revoke family
  scenario = "root-admin";
  await page.goto(`${origin}/?surface=root-admin&tab=profile`);
  await page.getByRole("tab", { name: "Root Authority" }).waitFor({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Root Authority" }).click();
  await page.getByTestId("root-authority-tab").waitFor();
  assert.equal(await page.getByTestId("root-authenticated-subject").textContent(), "user:usr_root_human");
  assert.match((await page.getByTestId("root-security-revision").textContent()) ?? "", /rev 5/);
  assert.match((await page.getByTestId("root-granted-vs-effective").textContent()) ?? "", /Root effective/i);
  checks.push("Explicit root operator sees real subject, revision, and effective status");

  // Grant root to a new agent
  await page.getByPlaceholder("agt_...").fill("agt_worker_2");
  await page.getByPlaceholder("Why is system root required for this subject?").fill("Browser smoke isolated grant");
  const grantCreateResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/root/grants",
  );
  await page.getByRole("button", { name: "Grant system root", exact: true }).click();
  assert.equal((await grantCreateResponse).status(), 201);
  await page.getByText("agent:agt_worker_2", { exact: true }).waitFor();
  assert.match((await page.getByTestId("root-security-revision").textContent()) ?? "", /rev 6/);
  checks.push("Root operator creates an explicit system root grant with expected_revision and Idempotency-Key");

  // Trigger 409 authority_revision_conflict and click Reload
  triggerNextGrantConflict = true;
  await page.getByPlaceholder("agt_...").fill("agt_conflict_target");
  await page.getByPlaceholder("Why is system root required for this subject?").fill("Trigger stale revision");
  const conflictResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/root/grants",
  );
  await page.getByRole("button", { name: "Grant system root", exact: true }).click();
  assert.equal((await conflictResponse).status(), 409);
  await page.getByTestId("root-revision-conflict-banner").waitFor();
  assert.match((await page.getByTestId("root-revision-conflict-banner").textContent()) ?? "", /8/);
  await page.screenshot({ path: join(artifacts, "root-admin-grants-and-conflict.png"), fullPage: true });
  await page.getByRole("button", { name: "Reload authority state", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="root-security-revision"]')?.textContent?.includes("rev 8"),
  );
  assert.equal(await page.getByTestId("root-revision-conflict-banner").count(), 0);
  checks.push("409 authority_revision_conflict displays current revision banner and reloads cleanly");

  // Revoke active grant and inspect exposed_external_secrets_requiring_rotation + last_root_revoked warnings
  await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByPlaceholder("Explain why this authority is being revoked").fill("Browser smoke revocation");
  const revokeResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname.endsWith("/revoke"),
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke", exact: true }).click();
  assert.equal((await revokeResponse).status(), 200);
  await page.getByTestId("root-last-revoked-warning").waitFor();
  await page.getByTestId("root-exposed-secrets-notice").waitFor();
  assert.match((await page.getByTestId("root-exposed-secrets-notice").textContent()) ?? "", /ext_secret_ci_deploy/);
  await page.screenshot({ path: join(artifacts, "root-admin-revoked-warnings.png"), fullPage: true });
  checks.push("Revoking root grant surfaces last_root_revoked warning and external secret rotation notice");

  // Revoke credential family
  await page.getByPlaceholder("fam_...").fill("fam_compromised_1");
  await page.getByPlaceholder("Explain the security incident or rotation reason").fill("Browser smoke incident containment");
  const familyResponse = page.waitForResponse(
    (resp) => resp.request().method() === "POST" && new URL(resp.url()).pathname === "/api/root/credential-families/fam_compromised_1/revoke",
  );
  await page.getByRole("button", { name: "Revoke family", exact: true }).click();
  assert.equal((await familyResponse).status(), 200);
  checks.push("Credential family security revocation submits expected_revision and reason_code");

  // 3. Agent-origin PAT context: never disguised as real human; distinguishes granted vs attempt-ineffective
  scenario = "agent-origin-ineffective";
  await page.goto(`${origin}/?surface=agent-origin-ineffective&tab=profile`);
  await page.getByTestId("account-agent-origin-notice").waitFor({ timeout: 30_000 });
  assert.match((await page.getByTestId("account-agent-origin-notice").textContent()) ?? "", /agent:agt_root_worker/);
  await page.getByRole("tab", { name: "API Tokens" }).click();
  await page.getByTestId("token-agent-origin-badge").waitFor();
  await page.getByText("family:fam_agent_1", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "Root Authority" }).click();
  await page.getByTestId("root-authority-tab").waitFor();
  assert.equal(await page.getByTestId("root-authenticated-subject").textContent(), "agent:agt_root_worker");
  await page.getByTestId("root-agent-origin-badge").waitFor();
  assert.match((await page.getByTestId("root-granted-vs-effective").textContent()) ?? "", /attempt_not_eligible/);
  await page.screenshot({ path: join(artifacts, "agent-origin-provenance.png"), fullPage: true });
  checks.push("Agent-origin PAT is explicitly labeled across Account, Tokens, and Root tabs and distinguishes granted vs attempt-ineffective");

  assert.deepEqual(pageErrors, [], "Browser runtime errors");
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
