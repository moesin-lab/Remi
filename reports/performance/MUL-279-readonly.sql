\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT version(), current_database(), clock_timestamp();
SELECT name, setting FROM pg_settings WHERE name IN ('shared_preload_libraries','compute_query_id','track_io_timing');
SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_stat_statements';
SELECT to_regclass('pg_stat_statements') IS NOT NULL AS has_statements \gset
\if :has_statements
SELECT queryid,calls,round(total_exec_time::numeric,2) AS total_exec_ms,round(mean_exec_time::numeric,2) AS mean_exec_ms,rows,shared_blks_hit,shared_blks_read,temp_blks_written,query FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 10;
SELECT queryid,calls,round(total_exec_time::numeric,2) AS total_exec_ms,round(mean_exec_time::numeric,2) AS mean_exec_ms,rows,query FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY calls DESC LIMIT 10;
\endif
SELECT pid,application_name,state,wait_event_type,wait_event,clock_timestamp()-query_start AS elapsed,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' ORDER BY query_start LIMIT 20;
SELECT relname,n_live_tup,n_dead_tup,seq_scan,seq_tup_read,idx_scan,last_autoanalyze FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 20;
ROLLBACK;
