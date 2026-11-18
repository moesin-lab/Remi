export interface MultiremiCliUpdateParticipant {
  provider: string;
  activeTaskCount(): number;
  activeTaskIds?(): string[];
  pendingClaimCount(): number;
  claimsPaused(): boolean;
  pauseClaims(): void;
  releaseClaims(): void;
}

export type MultiremiCliUpdatePauseResult =
  | { ok: true }
  | { ok: false; error: string };

/** Coordinates updates to the CLI binary shared by every provider on a machine. */
export class MultiremiCliUpdateCoordinator {
  private readonly participants: MultiremiCliUpdateParticipant[] = [];

  register(participant: MultiremiCliUpdateParticipant): void {
    this.participants.push(participant);
  }

  /** Pause once, then let accepted work finish without cancelling any task. */
  async pauseClaimsUntilIdle(deadline: number, stopped: () => boolean): Promise<MultiremiCliUpdatePauseResult> {
    if (this.participants.some(participant => participant.claimsPaused())) {
      return { ok: false, error: "CLI update already paused for maintenance" };
    }
    for (const participant of this.participants) participant.pauseClaims();
    while (true) {
      const busy = this.participants.filter(participant => participant.activeTaskCount() > 0 || participant.pendingClaimCount() > 0);
      if (stopped() || (busy.length && Date.now() >= deadline)) {
        const tasks = busy.map(participant => {
          const ids = (participant.activeTaskIds?.() ?? []).join(", ");
          return `${participant.provider}: ${ids || `${participant.activeTaskCount()} active tasks, ${participant.pendingClaimCount()} pending claims`}`;
        }).join("; ");
        this.releaseClaims();
        return { ok: false, error: stopped() ? "CLI update drain interrupted by shutdown" : `CLI update drain deadline exceeded; remaining tasks: ${tasks}` };
      }
      if (!busy.length) return { ok: true };
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(50, deadline - Date.now()))));
    }
  }

  releaseClaims(): void {
    for (const participant of this.participants) participant.releaseClaims();
  }
}
