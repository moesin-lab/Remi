export const DEFAULT_CO_AUTHORED_BY = { name: "Remi", email: "remi@openremi.fun" } as const;
export const CO_AUTHORED_BY_NAME_MAX_LENGTH = 100;
export const CO_AUTHORED_BY_EMAIL_MAX_LENGTH = 254;
export type CoAuthoredByIdentity = { name: string; email: string };
type Validation = { ok: true; value: string } | { ok: false; error: string };

function validate(value: string, max: number): Validation {
  // Reject controls even at the edges; trimming must not hide trailer injection.
  if (/[\p{Cc}<>]/u.test(value)) return { ok: false, error: "Control characters and angle brackets are not allowed" };
  value = value.trim();
  if (!value) return { ok: false, error: "Must not be empty" };
  if ([...value].length > max) return { ok: false, error: `Must be at most ${max} characters` };
  return { ok: true, value };
}
export function validateCoAuthoredByName(value: string): Validation {
  return validate(value, CO_AUTHORED_BY_NAME_MAX_LENGTH);
}
export function validateCoAuthoredByEmail(value: string): Validation {
  const result = validate(value, CO_AUTHORED_BY_EMAIL_MAX_LENGTH);
  if (!result.ok) return result;
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(result.value)) {
    return { ok: false, error: "Must be an email with a dotted domain and no whitespace" };
  }
  return result;
}
export function formatCoAuthoredByTrailer({ name, email }: CoAuthoredByIdentity): string {
  return `Co-authored-by: ${name} <${email}>`;
}
export function resolveCoAuthoredByIdentity(settings: Record<string, unknown>): CoAuthoredByIdentity {
  const name = typeof settings.co_authored_by_name === "string" ? validateCoAuthoredByName(settings.co_authored_by_name) : null;
  const email = typeof settings.co_authored_by_email === "string" ? validateCoAuthoredByEmail(settings.co_authored_by_email) : null;
  return { name: name?.ok ? name.value : DEFAULT_CO_AUTHORED_BY.name, email: email?.ok ? email.value : DEFAULT_CO_AUTHORED_BY.email };
}
