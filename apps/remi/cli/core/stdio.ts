import { Console } from "node:console";

/** Use the same queued streams for console output and the final flush. Bun's
 * native console writes do not go through process.stdout's write queue. */
export function configureCliStdio(): void {
  Object.assign(globalThis.console, new Console({
    stdout: process.stdout,
    stderr: process.stderr,
    ignoreErrors: false,
  }));
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      // A consumer such as `head` can close the pipe before we finish writing.
      if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw error;
    });
  }
}

/** An empty write callback runs after all preceding writes, including partial
 * pipe writes. Do not end the streams: daemon commands may still own them. */
export async function flushCliStdio(): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((resolve, reject) => {
      stream.write("", (error) => error ? reject(error) : resolve());
    }),
  ));
}
