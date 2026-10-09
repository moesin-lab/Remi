import { expect, it } from "bun:test";
import { migrateFeishuMultipleBots } from "@multiremi/store/migrations.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";

unifiedModelBackendTests("Feishu multiple-bot migration", fixture => {
  it("preserves legacy credentials, permissions and referenced conversations, then permits isolated bot identities", () => {
    const { db, store } = fixture();
    const at = "2026-10-01T00:00:00.000Z";
    const agent = store.createAgent({ name: "Existing bot", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id });
    const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Existing message" });
    db.run("INSERT INTO multiremi_runtimes(id,name,provider,workspace_id,created_at,updated_at) VALUES('rt_old','Old host','codex','local',?,?)", [at, at]);
    db.run(`INSERT INTO multiremi_feishu_bot_configs(workspace_id,agent_id,runtime_id,app_id,app_secret_encrypted,enabled,revision,created_at,updated_at)
      VALUES('local',?,'rt_old','cli_old','preserved-ciphertext',1,7,?,?)`, [agent.id, at, at]);
    db.run("INSERT INTO multiremi_feishu_bot_runtime_states(workspace_id,runtime_id,applied_revision,state,reported_at) VALUES('local','rt_old',7,'online',?)", at);
    db.run("INSERT INTO multiremi_feishu_bot_agent_routes(id,workspace_id,scope,agent_id,created_at,updated_at) VALUES('route_old','local','p2p_default',?,?,?)", [agent.id, at, at]);
    db.run("INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,app_id,open_id,display_name,allowed,first_seen_at,last_seen_at) VALUES('sender_old','local','cli_old','ou_old','Existing sender',1,?,?)", [at, at]);
    db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings(id,workspace_id,app_id,agent_id,external_session_key,chat_session_id,created_at,updated_at)
      VALUES('binding_old','local','cli_old',?,'p2p:oc_old',?,?,?)`, [agent.id, chat.id, at, at]);
    db.run("INSERT INTO multiremi_feishu_bot_deliveries(workspace_id,external_message_id,binding_id,task_id,created_at,updated_at) VALUES('local','om_old','binding_old',?,?,?)", [task.id, at, at]);
    db.run("INSERT INTO multiremi_feishu_bot_audit(id,workspace_id,seq,action,created_at) VALUES('audit_old','local',1,'created',?)", at);
    const tables = ["configs", "runtime_states", "agent_routes", "senders", "chat_bindings", "deliveries", "audit", "inbound_attachments"];
    const before = tables.map(suffix => db.query(`SELECT * FROM multiremi_feishu_bot_${suffix}`).all());
    if (db.dialect !== "postgres") db.exec("PRAGMA foreign_keys = ON");

    migrateFeishuMultipleBots(db);
    migrateFeishuMultipleBots(db);

    for (const [index, suffix] of tables.entries()) {
      const rows = db.query(`SELECT * FROM multiremi_feishu_bot_${suffix}`).all();
      expect(rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !["bot_id", "name", "release_pending", "stopping_app_id"].includes(key))))).toEqual(before[index]);
      for (const row of rows) expect(row.bot_id).toBe("default");
    }
    if (db.dialect !== "postgres") {
      expect(db.query("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    db.run("INSERT INTO multiremi_feishu_bot_deliveries(workspace_id,bot_id,external_message_id,binding_id,task_id,created_at,updated_at) VALUES('local','bot_second','om_old','binding_old',?,?,?)", [task.id, at, at]);
    db.run("INSERT INTO multiremi_feishu_bot_agent_routes(id,workspace_id,bot_id,scope,agent_id,created_at,updated_at) VALUES('route_second','local','bot_second','p2p_default',?,?,?)", [agent.id, at, at]);
    db.run("INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,bot_id,app_id,open_id,display_name,first_seen_at,last_seen_at) VALUES('sender_second','local','bot_second','cli_old','ou_old','New sender',?,?)", [at, at]);
    expect(() => db.run("INSERT INTO multiremi_feishu_bot_agent_routes(id,workspace_id,bot_id,scope,agent_id,created_at,updated_at) VALUES('route_duplicate','local','bot_second','p2p_default',?,?,?)", [agent.id, at, at])).toThrow();
    expect(Number(db.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_deliveries").get()?.n)).toBe(2);
    expect(db.query("SELECT allowed FROM multiremi_feishu_bot_senders WHERE id='sender_second'").get()?.allowed).toBe(0);
  });
});
