import type {SqlDatabase} from '../db/postgres.js';

/** Human notification cards are projections of messages and member lane cursors. */
export function createMemberInboxReadProjection(db:SqlDatabase):void {
  const cols=db.query('PRAGMA table_info(multiremi_conversation_heads)').all().map(row=>row.name);
  if(!cols.includes('workspace_id')){
    db.exec('ALTER TABLE multiremi_conversation_heads ADD COLUMN workspace_id TEXT');
    db.exec(`UPDATE multiremi_conversation_heads SET workspace_id=COALESCE(
      (SELECT workspace_id FROM multiremi_issue_sessions s WHERE s.id=multiremi_conversation_heads.session_id),
      (SELECT workspace_id FROM multiremi_chat_sessions c WHERE c.id=multiremi_conversation_heads.session_id),
      (SELECT workspace_id FROM multiremi_autopilots a WHERE a.session_id=multiremi_conversation_heads.session_id),
      (SELECT workspace_id FROM multiremi_turns t WHERE t.session_id=multiremi_conversation_heads.session_id LIMIT 1)) WHERE workspace_id IS NULL`);
  }
  // Keep old recipient-specific receipts for historical rows. Shared reads have
  // their own workspace key and never weaken the Agent lane schema invariant.
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_workspace_read_cursors (
    workspace_id TEXT NOT NULL REFERENCES multiremi_workspaces(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES multiremi_conversation_heads(session_id) ON DELETE CASCADE,
    cursor_seq INTEGER NOT NULL DEFAULT 0 CHECK(cursor_seq >= 0),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, session_id)
  )`);
  const json=(key:string)=>db.dialect==='postgres'?`m.metadata::jsonb #>> '{inbox_item,${key}}'`:`json_extract(m.metadata,'$.inbox_item.${key}')`;
  if(db.dialect!=='postgres')db.exec('DROP VIEW IF EXISTS multiremi_member_inbox_records');
  db.exec(`${db.dialect==='postgres'?'CREATE OR REPLACE VIEW':'CREATE VIEW'} multiremi_member_inbox_records AS
    SELECT m.id,h.workspace_id,s.issue_id,COALESCE(operator.id,m.to_member_id) AS member_id,'member' AS recipient_type,COALESCE(operator.id,m.to_member_id) AS recipient_id,
    COALESCE(${json('severity')},CASE WHEN m.message_kind='decision' THEN 'action' ELSE 'info' END) AS severity,
    m.sender_type AS actor_type,m.sender_id AS actor_id,COALESCE(${json('type')},m.message_kind) AS type,
    COALESCE(${json('title')},SUBSTR(m.body_md,1,160)) AS title,m.body_md AS body,${json('details')} AS details,
    CASE WHEN m.seq<=COALESCE(l.cursor_seq,0) OR m.seq<=COALESCE(shared.cursor_seq,0) THEN 1 ELSE 0 END AS read,
    CASE WHEN m.resolved_at IS NOT NULL THEN 1 ELSE 0 END AS archived,m.created_at
    FROM multiremi_conversation_log m JOIN multiremi_conversation_heads h ON h.session_id=m.session_id
    LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id
    LEFT JOIN multiremi_session_lanes l ON l.session_id=m.session_id AND l.reader_type='member' AND l.reader_id=m.to_member_id AND l.execution_scope=''
    LEFT JOIN multiremi_workspace_members operator ON operator.id=(
      SELECT candidate.id FROM multiremi_workspace_members candidate
      WHERE candidate.workspace_id=h.workspace_id AND candidate.user_id='local'
      ORDER BY CASE WHEN candidate.id='mem_' || h.workspace_id || '_local' THEN 0 ELSE 1 END,
        candidate.created_at,candidate.id LIMIT 1)
    LEFT JOIN multiremi_workspace_read_cursors shared ON shared.session_id=m.session_id AND shared.workspace_id=h.workspace_id
    WHERE m.kind='message' AND m.to_member_id IS NOT NULL AND m.deleted_at IS NULL`);
}
