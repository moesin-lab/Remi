import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import inputs from "../packages/platform-updater/src/data-schema-inputs.json" with { type: "json" };

// Normalize checkout line endings so Windows and Linux produce the same value.
const source = (await Promise.all(inputs.map((path) => readFile(resolve(process.argv[2] ?? ".", path), "utf8")))).join("");
console.log(createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex"));
