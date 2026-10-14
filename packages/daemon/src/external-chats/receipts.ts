import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { ExternalChatReceipt } from "@multiremi/contracts/external-chats";
import { hash } from "./sources.js";

export interface SavedReceipt extends ExternalChatReceipt { source_id: string; payload_hash: string }

export class Receipts {
  constructor(private root: string, private uid: number | undefined) { this.root = resolve(root); }

  private path(source: string, request: string): string { return join(this.root, `${hash(`${source}\0${request}`)}.json`); }

  read(source: string, request: string): SavedReceipt | null {
    const path = this.path(source, request);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== this.uid || stat.nlink !== 1 || stat.size > 8_192) throw new Error("Invalid receipt file");
      const receipt = JSON.parse(readFileSync(fd, "utf8")) as SavedReceipt;
      if (receipt.source_id !== source || receipt.request_id !== request || typeof receipt.thread_id !== "string"
        || typeof receipt.payload_hash !== "string" || !["unknown", "accepted"].includes(receipt.outcome)
        || receipt.turn_id !== null && typeof receipt.turn_id !== "string") throw new Error("Invalid receipt binding");
      return receipt;
    } finally { closeSync(fd); }
  }

  /** Exclusive creation wins before native input; a partial/corrupt file always fails closed. */
  create(receipt: SavedReceipt): boolean {
    this.prepare();
    const path = this.path(receipt.source_id, receipt.request_id);
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try { writeFileSync(fd, JSON.stringify(receipt) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.syncDirectory();
    return true;
  }

  update(receipt: SavedReceipt): void {
    this.prepare();
    const previous = this.read(receipt.source_id, receipt.request_id);
    if (!previous || previous.thread_id !== receipt.thread_id || previous.payload_hash !== receipt.payload_hash) throw new Error("Invalid receipt binding");
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(receipt) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, this.path(receipt.source_id, receipt.request_id));
    this.syncDirectory();
  }

  private prepare(): void {
    const created = mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid) throw new Error("Invalid receipt directory");
    if (created) {
      const existingParent = dirname(created);
      for (let directory = this.root; directory !== existingParent; directory = dirname(directory)) this.syncDirectory(directory);
      this.syncDirectory(existingParent);
    }
  }

  private syncDirectory(directory = this.root): void {
    const fd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
