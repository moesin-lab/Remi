/** References and receipts only: no credentials, message bodies or provider input. */
export interface PlannedRestartCheckpoint {
  version: 1;
  session_id: string | null;
  work_dir: string | null;
  trace_head: number;
  input_ack_seq: number;
  delivered_message_ids: string[];
}
