export class BotError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_bot") {
    super(message);
    this.name = "BotError";
  }
}
