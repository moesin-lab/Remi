import { waitForShutdown } from "../../apps/remi/cli/multiremi.js";
const shutdown = waitForShutdown(async () => {
  console.log("stopping");
  await new Promise(() => {});
});
console.log("ready");
await shutdown;
