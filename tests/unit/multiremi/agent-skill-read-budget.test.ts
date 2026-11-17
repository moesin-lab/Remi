import { afterEach, expect, test } from "bun:test";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

test("ordinary Agent reads never fetch linked Skill files, with a 1277-file shared bundle", () => {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Skill budget", provider: "codex" });
  const skill = store.createSkill({ name: "Large shared bundle", description: "Shared", content: "# Bundle",
    files: Array.from({ length: 1277 }, (_, n) => ({ path: `files/${n.toString().padStart(4, "0")}.txt`, content: "x".repeat(10_240) })),
  });
  const agents = Array.from({ length: 9 }, (_, n) => store.createAgent({ name: `Reader ${n}`, provider: "codex", runtimeId: runtime.id }));
  for (const agent of agents) store.setAgentSkills(agent.id, [skill.id!]);
  const defaultAgent = store.ensureDefaultAgent("codex");
  store.setAgentSkills(defaultAgent.id, [skill.id!]);
  const db = (store as unknown as { db: SqlDatabase }).db;
  const query = db.query.bind(db);
  let sql: string[] = [];
  let fileBytes = 0;
  db.query = ((text: string) => {
    const statement = query(text);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (["get", "all", "run", "values"].includes(String(key))) return (...args: unknown[]) => {
        sql.push(text);
        const result = value.apply(target, args);
        if (/FROM multiremi_skill_files/.test(text) && Array.isArray(result)) {
          fileBytes += result.reduce((sum, row) => sum + Buffer.byteLength(row.content ?? ""), 0);
        }
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof db.query;
  try {
    const started = performance.now();
    const reads = [
      store.getAgent(agents[0]!.id), store.getAgentByRef(agents[0]!.name),
      store.getDefaultAgent("local", "codex", "local"),
      ...store.listAgents(), ...store.listActiveAgentsByRuntime(runtime.id),
    ];
    for (const agent of reads) expect(agent?.skills[0]?.id).toBe(skill.id!);
    store.getSkill(skill.id!);
    store.getSkill(skill.id!, {});
    store.getSkill(skill.id!, { includeArchived: true });
    store.listAgentSkills(agents[0]!.id);
    console.log("MUL85_SKILL_READ_BUDGET", JSON.stringify({ agents: 10, files: 1277, bundleBytes: 1277 * 10_240,
      sql: sql.length, fileQueries: sql.filter(text => /FROM multiremi_skill_files/.test(text)).length, fileBytes,
      elapsedMs: performance.now() - started }));
    expect(sql.filter(text => /FROM multiremi_skill_files/.test(text))).toEqual([]);
    expect(reads.every(agent => agent?.skills[0]?.files?.length === 0)).toBe(true);
    sql = [];
    store.listAgents();
    expect(sql).toHaveLength(2); // Agent rows + one bounded batch of linked Skill summaries.
    sql = [];
    expect(store.getAgent(agents[0]!.id, { includeFiles: true })?.skills[0]?.files).toHaveLength(1277);
    expect(sql.filter(text => /FROM multiremi_skill_files/.test(text))).toHaveLength(1);
    expect(store.getSkill(skill.id!, { includeFiles: true })?.files).toHaveLength(1277);
    expect(store.listAgentSkills(agents[0]!.id, { includeFiles: true })[0]?.files).toHaveLength(1277);
    // No cache: edits are visible immediately and archived linked Skills disappear.
    store.upsertSkillFile(skill.id!, { path: "files/0000.txt", content: "fresh" });
    expect(store.getAgent(agents[0]!.id, { includeFiles: true })?.skills[0]?.files?.[0]?.content).toBe("fresh");
    store.archiveSkill(skill.id!);
    expect(store.getAgent(agents[0]!.id)?.skills).toEqual([]);
    expect(store.getSkill(skill.id!)).toBeNull();
    expect(store.getSkill(skill.id!, { includeArchived: true, includeFiles: true })?.files).toHaveLength(1277);
  } finally { db.query = query; }
});
