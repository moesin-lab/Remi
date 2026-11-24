import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createStatusPagesHarness, STATUS_PAGE_STATUSES as STATUSES } from "../../fixtures/multiremi/issue-status-pages-fixture.js";

describe(`MUL-395 status pages (${process.env.MULTIREMI_TEST_POSTGRES_URL ? "Postgres" : "SQLite"})`, () => {
  let h: Awaited<ReturnType<typeof createStatusPagesHarness>>;
  beforeAll(async () => { h = await createStatusPagesHarness(process.env.MULTIREMI_TEST_POSTGRES_URL); }, 20000);
  afterAll(async () => { await h?.close(); });

  async function measuredRequest(path: string) {
    // A warm HTTP request can hit a readiness TTL that is about to expire.
    // Refresh it before the harness resets the SQL probe, for every sample.
    h.store.checkDatabaseReady(true);
    return h.request(path);
  }

  async function equivalent(filter = "", statuses = STATUSES, limit = 50) {
    const grouped = await h.request(`/api/issues/status-pages?statuses=${statuses.join(",")}&limit=${limit}${filter}`);
    expect(grouped.status).toBe(200);
    expect(Object.keys(grouped.body.groups)).toEqual(statuses);
    for (const status of statuses) {
      const single = await h.request(`/api/issues?status=${status}&limit=${limit}&offset=0${filter}`);
      expect(single.status).toBe(200);
      const { issues, total, has_more } = grouped.body.groups[status];
      expect(JSON.stringify({ issues, total })).toBe(single.text);
      expect(has_more).toBe(issues.length < total);
    }
    return grouped.body;
  }

  it("matches all seven independent first pages byte for byte with 120 issues per status", async () => {
    const result = await equivalent("&project_id=prj_status_primary");
    for (const group of Object.values(result.groups) as any[]) {
      expect(group.issues).toHaveLength(50);
      expect(group.total).toBe(120);
    }
  });
  it("matches usr_, mem_, agt_ and untyped assignee references", async () => {
    for (const ref of [h.userId, h.memberId, "agt_status_pages", "Status reader"]) {
      await equivalent(`&project_id=prj_status_primary&assignee_id=${encodeURIComponent(ref)}`);
    }
    await equivalent("&assignee_types=agent&assignee_id=agt_status_pages");
  });
  it("keeps the existing sorting semantics, including tied timestamps", async () => {
    await equivalent("&project_id=prj_status_ties&sort_by=priority&sort_order=asc", STATUSES, 19);
    await equivalent("&project_id=prj_status_primary&sort_by=created_at&sort_order=desc");
  });
  it("matches project, priority, plural assignee and project, null and hierarchy filters", async () => {
    for (const filter of [
      "&project_id=prj_status_other&priority=high", "&project_ids=prj_status_primary,prj_status_other",
      `&assignee_ids=${h.memberId},agt_status_pages`, "&include_no_assignee=true", "&include_no_project=true",
      "&parent_id=iss_parent_status", "&top_level_only=true", "&parent_id=iss_parent_status&top_level_only=true",
    ]) await equivalent(filter);
  });
  it("matches metadata filters and archived page modes", async () => {
    await equivalent(`&metadata=${encodeURIComponent(JSON.stringify({ lane: 1, reviewed: true }))}`);
    await equivalent("&archived_only=true");
    await equivalent("&include_archived=true");
  });
  it("keeps empty buckets and totals with limit=0", async () => {
    const empty = await equivalent("&project_id=prj_absent");
    for (const group of Object.values(empty.groups)) expect(group).toEqual({ issues: [], total: 0, has_more: false });
    await equivalent("&project_id=prj_status_primary", STATUSES, 0);
  });
  it("only counts archives when requested, using the workspace-wide count", async () => {
    const without = await measuredRequest("/api/issues/status-pages?statuses=todo&limit=50&project_id=prj_status_primary");
    const withCount = await measuredRequest("/api/issues/status-pages?statuses=todo&limit=50&project_id=prj_status_primary&include_archived_total=true");
    const single = await h.request("/api/issues?archived_only=true&limit=0");
    expect(without.body).not.toHaveProperty("archived_total");
    expect(withCount.body.archived_total).toBe(single.body.total);
    expect(withCount.body.archived_total).toBe(21);
    expect(withCount.dbq).toBe(without.dbq + 1);
    expect(single.body).not.toHaveProperty("archived_total");
  });
  it("reproduces the archive budget mismatch at readiness expiry and measures a fresh TTL", async () => {
    const path = "/api/issues/status-pages?statuses=todo&limit=50&project_id=prj_status_primary";
    const readySql = "SELECT 1 AS ready";
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (const request of [h.request, measuredRequest]) {
        h.store.checkDatabaseReady(true);
        now += 999;
        const warm = await h.request("/api/issues/status-pages?statuses=todo&limit=0");
        expect(warm.statements).not.toContain(readySql);
        now++;
        const without = await request(path);
        const withCount = await request(`${path}&include_archived_total=true`);
        expect(without.status).toBe(200);
        expect(withCount.status).toBe(200);
        expect(withCount.body.archived_total).toBe(21);
        const { archived_total, ...body } = withCount.body;
        expect(body).toEqual(without.body);
        expect(withCount.statements).not.toContain(readySql);
        if (request === h.request) {
          // Exactly the reported 9 != 10 mechanism: the extra archive SQL
          // replaces the readiness SQL charged only to the baseline request.
          expect(without.statements.filter(sql => sql === readySql)).toHaveLength(1);
          expect(withCount.dbq).toBe(without.dbq);
        } else {
          expect(without.statements).not.toContain(readySql);
          expect(withCount.dbq).toBe(without.dbq + 1);
        }
      }
    } finally {
      clock.mockRestore();
      h.store.checkDatabaseReady(true);
    }
  });
  it("keeps counts in the selected workspace while shared humans can select another", async () => {
    const grouped = await h.request("/api/issues/status-pages?statuses=todo&include_archived_total=true");
    const bucket = grouped.body.groups.todo;
    expect(bucket.issues.some((issue: any) => issue.id.startsWith("iss_hidden"))).toBe(false);
    expect(bucket.issues.every((issue: any) => issue.workspace_id === "local")).toBe(true);
    expect(bucket.total).toBe(h.store.countIssues({ workspaceId: "local", statuses: ["todo"] }));
    for (const path of ["/api/issues", "/api/issues/status-pages"]) {
      const response = await h.request(`${path}?workspace_id=foreign`);
      expect(response.status).toBe(200);
      const issues = path.endsWith('status-pages')
        ? Object.values(response.body.groups).flatMap((group: any) => group.issues)
        : response.body.issues;
      expect(issues.every((issue: any) => issue.workspace_id === 'foreign')).toBe(true);
    }
  });
  it("assignee boards opt into the same workspace archive count without changing default responses", async () => {
    for (const prefix of ["/api/issues", "/api/multiremi/issues"]) {
      const path = `${prefix}/grouped?group_by=assignee&project_id=prj_absent`;
      const without = await measuredRequest(path);
      const withCount = await measuredRequest(`${path}&include_archived_total=true`);
      expect(without.body).not.toHaveProperty("archived_total");
      const { archived_total, ...groups } = withCount.body;
      expect(groups).toEqual(without.body);
      expect(archived_total).toBe(21);
      expect(withCount.dbq).toBe(without.dbq + 1);
      const foreign = await h.request(`${path}&workspace_id=foreign&include_archived_total=true`);
      expect(foreign.status).toBe(200);
      expect(foreign.body.archived_total).toBe(h.store.countIssues({ workspaceId: 'foreign', archivedOnly: true }));
    }
  });
  it("dbq golden: stays constant across 1/4/7 statuses and 1/60/300 issues per status", async () => {
    const measurements: number[] = [];
    const profiles: unknown[] = [];
    for (const count of [1, 60, 300]) {
      for (const width of [1, 4, 7]) {
        const result = await measuredRequest(`/api/issues/status-pages?statuses=${STATUSES.slice(0, width).join(",")}&project_id=prj_status_scale${count}&limit=50&include_archived_total=true`);
        expect(result.status).toBe(200);
        expect(Object.values(result.body.groups).map((group: any) => group.total)).toEqual(Array(width).fill(count));
        measurements.push(result.dbq);
        profiles.push({ count, width, statements: result.statements });
      }
    }
    if (new Set(measurements).size !== 1) console.info('STATUS_SQL_DIFF', JSON.stringify(profiles));
    expect(new Set(measurements).size).toBe(1);
    const single = await measuredRequest("/api/issues?status=todo&limit=50&project_id=prj_status_scale300");
    expect(measurements[8]!).toBeLessThanOrEqual(single.dbq * 2);
  });
  it("snapshot: state moves, labels and archives remain consistent across reads", async () => {
    const path = "/api/issues/status-pages?project_id=prj_status_primary&include_archived_total=true";
    const before = await h.request(path);
    const writer = h.writer();
    const id = "iss_primary_todo_119";
    let changed = false;
    let statusChanged = false;
    let labelsDeleted = false;
    h.probe.afterRead = (sql) => {
      if (changed || !sql.includes("UNION ALL")) return;
      changed = true;
      writer.run("UPDATE multiremi_issues SET status = ?, archived_at = ? WHERE id = ?", "in_progress", "2026-09-28", id);
      statusChanged = true;
      writer.run("DELETE FROM multiremi_issue_to_labels WHERE issue_id = ?", id);
      labelsDeleted = true;
    };
    try {
      const during = await h.request(path);
      expect(changed).toBe(true);
      expect(during.status).toBe(200);
      expect(during.text).toBe(before.text);
      expect(h.store.countIssues({ workspaceId: "local", archivedOnly: true })).toBe(22);
    } finally {
      h.probe.afterRead = undefined;
      try {
        if (statusChanged) writer.run("UPDATE multiremi_issues SET status = ?, archived_at = NULL WHERE id = ?", "todo", id);
        if (labelsDeleted) writer.run("INSERT INTO multiremi_issue_to_labels (issue_id, label_id) VALUES (?, ?)", id, "lbl_status");
      } finally {
        writer.close();
      }
    }
  });
  it("defaults to seven states, normalizes open and rejects later pages", async () => {
    const defaults = await h.request("/api/issues/status-pages");
    expect(Object.keys(defaults.body.groups)).toEqual(STATUSES);
    const open = await h.request("/api/issues/status-pages?statuses=open,todo");
    expect(Object.keys(open.body.groups)).toEqual(["todo"]);
    expect((await h.request("/api/issues/status-pages?offset=50")).status).toBe(400);
  });
});
