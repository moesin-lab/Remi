-- t0: read-only discovery. Do not CREATE EXTENSION or reset statistics.
SELECT clock_timestamp() AS sampled_at, current_database(), current_user, version();
SELECT e.extname, n.nspname AS extension_schema
FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
WHERE e.extname='pg_stat_statements';
SELECT name, setting FROM pg_settings
WHERE name IN ('shared_preload_libraries','pg_stat_statements.track','track_activity_query_size');

-- Only if already installed: replace public with extension_schema from above.
-- Export every row at t0 and t1=t0+10min; join by dbid/userid/queryid/toplevel,
-- take counter deltas, rank by calls and total_exec_time. Negative deltas imply
-- reset/eviction and must not be treated as valid interval counts.
SELECT clock_timestamp() AS sampled_at, dbid, userid, queryid, toplevel,
       calls, total_exec_time, rows, query
FROM public.pg_stat_statements
WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database());
SELECT clock_timestamp() AS sampled_at, stats_reset, dealloc
FROM public.pg_stat_statements_info;

-- Fallback activity samples (owner runs once per second for the same 10 min).
-- No sleeping query or configuration change needed. These are samples, not calls.
SELECT clock_timestamp() AS sampled_at, pid, application_name, backend_type,
       state, wait_event_type, wait_event, query_id, query_start, query
FROM pg_stat_activity
WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active';
