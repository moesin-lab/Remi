import type { BotDirective, BotOutboundDelivery } from "@multiremi/contracts/bots.js";
import { redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import type { MultiremiFeishuBotAssignment } from "./client.js";
import {
  FeishuConciergeSupervisor,
  type FeishuConciergeHost,
  type FeishuConciergeStatusReport,
} from "./feishu-concierge.js";

export interface BotConciergeSupervisorOptions {
  createHost: (directive: BotDirective) => FeishuConciergeHost;
  fetchConfig: (directive: BotDirective) => Promise<MultiremiFeishuBotAssignment | null>;
  report: (directive: BotDirective, report: FeishuConciergeStatusReport) => Promise<void>;
  claimOutbound: (directive: BotDirective) => Promise<BotOutboundDelivery | null>;
  reportOutbound: (directive: BotDirective, delivery: BotOutboundDelivery, result: {
    status: "sent" | "failed";
    externalMessageId?: string;
    error?: string;
  }) => Promise<void>;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

/** Each platform binding owns a transport; execution remains on the control plane. */
export class BotConciergeSupervisor {
  private readonly bindings = new Map<string, {
    directive: BotDirective;
    supervisor: FeishuConciergeSupervisor;
  }>();
  private reconciling: Promise<void> = Promise.resolve();
  private stopped = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: BotConciergeSupervisorOptions) {}

  apply(directives: BotDirective[]): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.reconciling = this.reconciling.catch(() => {}).then(async () => {
      if (this.stopped) return;
      const present = new Set(directives.map((directive) => directive.platform_binding_id));
      await Promise.all([...this.bindings].filter(([id]) => !present.has(id)).map(async ([id, entry]) => {
        await entry.supervisor.shutdown();
        this.bindings.delete(id);
      }));
      // Independent accounts may connect concurrently. Each account's existing
      // supervisor serializes restarts, redacts credentials and applies backoff.
      const results = await Promise.allSettled(directives.map(async (directive) => {
        let entry = this.bindings.get(directive.platform_binding_id);
        if (!entry) {
          const supervisor = new FeishuConciergeSupervisor({
            host: this.options.createHost(directive),
            fetchConfig: () => this.options.fetchConfig(directive),
            report: (report) => this.options.report(directive, report),
            log: this.options.log,
          });
          entry = { directive, supervisor };
          this.bindings.set(directive.platform_binding_id, entry);
        }
        entry.directive = directive;
        await entry.supervisor.apply(directive);
        if (this.stopped || entry.supervisor.snapshot().state !== "online") return;
        await this.deliverOutbound(entry.directive, entry.supervisor);
      }));
      for (const result of results) {
        if (result.status === "rejected") this.options.log?.warn(`Bot connection reconcile failed: ${redactFeishuBotError(result.reason)}`);
      }
    });
    return this.reconciling;
  }

  async reportChannelFailure(bindingId: string, error: unknown): Promise<void> {
    await this.bindings.get(bindingId)?.supervisor.reportChannelFailure(error);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    // A start may still be awaiting the platform handshake. Wait for it before
    // stopping, so no transport can finish starting after daemon shutdown.
    this.shutdownPromise = (async () => {
      await this.reconciling.catch(() => {});
      await Promise.all([...this.bindings.values()].map((entry) => entry.supervisor.shutdown()));
      this.bindings.clear();
    })();
    return this.shutdownPromise;
  }

  private async deliverOutbound(directive: BotDirective, supervisor: FeishuConciergeSupervisor): Promise<void> {
    const delivery = await this.options.claimOutbound(directive);
    if (!delivery) return;
    let result: { status: "sent" | "failed"; externalMessageId?: string; error?: string };
    try {
      const sent = await supervisor.sendOutbound(delivery);
      result = { status: "sent", externalMessageId: sent.messageId };
    } catch (error) {
      result = { status: "failed", error: redactFeishuBotError(error) };
    }
    // A failed acknowledgement is not a failed platform send. The server's
    // lease and the delivery's stable idempotency key make the next claim safe.
    await this.options.reportOutbound(directive, delivery, result);
  }
}
