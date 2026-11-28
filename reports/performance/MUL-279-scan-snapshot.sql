-- psql -X -qAt -v ON_ERROR_STOP=1 produces one JSON document.
-- Run twice in separate sessions; do not leave a transaction open between samples.
-- No extension, DDL, counter reset, ANALYZE or application writes.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT jsonb_build_object(
  'captured_at', clock_timestamp(),
  'database', current_database(),
  'database_oid', d.datid,
  'stats_reset', d.stats_reset,
  'postmaster_start', pg_postmaster_start_time(),
  'server_version', current_setting('server_version'),
  'track_counts', current_setting('track_counts'),
  'tables', (SELECT jsonb_agg(jsonb_build_object(
    'schema', s.schemaname, 'name', s.relname, 'oid', s.relid,
    'seq_scan', s.seq_scan, 'seq_tup_read', s.seq_tup_read,
    'idx_scan', COALESCE(s.idx_scan, 0), 'idx_tup_fetch', COALESCE(s.idx_tup_fetch, 0),
    'n_live_tup', s.n_live_tup, 'n_dead_tup', s.n_dead_tup,
    'last_analyze', s.last_analyze, 'last_autoanalyze', s.last_autoanalyze
  ) ORDER BY s.schemaname, s.relname)
  FROM pg_stat_user_tables s
  WHERE s.relname IN (
    'multiremi_usage_units', 'multiremi_turn_attempts',
    'multiremi_conversation_log', 'multiremi_turns',
    'multiremi_feishu_bot_chat_bindings', 'multiremi_scm_sync_cursors',
    'multiremi_issue_sessions'
  ))
) FROM pg_stat_database d WHERE d.datname = current_database();
ROLLBACK;
