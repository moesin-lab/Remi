import type {
  MultiremiPlatformDeploymentDriver,
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  MultiremiPlatformPreflight,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import type { PlatformDrainGate } from "./drain.js";

export interface PlatformInspection {
  driver: MultiremiPlatformDeploymentDriver;
  currentRelease: MultiremiPlatformRelease | null;
  recentReleases: MultiremiPlatformRelease[];
  services: MultiremiPlatformService[];
}

export interface PlatformDeploymentDriver {
  readonly kind: MultiremiPlatformDeploymentDriver;
  /** Recover committed host changes before depending on the control API. */
  recoverInterrupted?(): Promise<void>;
  inspect(): Promise<PlatformInspection>;
  preflight(): Promise<MultiremiPlatformPreflight>;
  execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    /**
     * Required for every service mutation (update/rollback/restart). Wait here
     * between preparing artifacts (image pull / build) and the service switch,
     * and the caller releases it after the operation finishes.
     */
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease | null>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdoutFile?: string;
  stdinFile?: string;
}

export class BunCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: options.stdoutFile ? Bun.file(options.stdoutFile) : "pipe",
      stdin: options.stdinFile ? Bun.file(options.stdinFile) : "ignore",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      typeof proc.stdout === "number" ? Promise.resolve("") : new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }
}
