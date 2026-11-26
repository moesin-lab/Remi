export function wireOfferAdopt(offer: { rt?: string; p?: Record<string, any> }, daemonId: string) {
  const payload = offer.p!;
  return { v: 2, t: "task.offer_adopt", id: crypto.randomUUID(), rt: offer.rt, p: {
    workspace_id: payload.workspace_id, daemon_id: daemonId, runtime_id: offer.rt, attempt_id: payload.attempt_id,
    content_hash: payload.system_prompt_policy.contentHash, offer_generation: payload.offer_generation, receipt_id: crypto.randomUUID(),
  } };
}
