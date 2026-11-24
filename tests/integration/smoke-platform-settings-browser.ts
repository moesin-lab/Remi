/** Node/Playwright companion to smoke-platform-settings.ts. Test credentials use stdin. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const { frontend, apiToken, updaterToken, control, artifacts } = JSON.parse(readFileSync(0, 'utf8')) as Record<string, string>;
const text = JSON.parse(readFileSync(new URL('../../frontend/packages/views/locales/en/settings.json', import.meta.url), 'utf8')).platform;
const zhText = JSON.parse(readFileSync(new URL('../../frontend/packages/views/locales/zh-Hans/settings.json', import.meta.url), 'utf8')).platform;
const checks: string[] = [], jsErrors: string[] = [], failures: string[] = [], mutations: string[] = [];
const redact = (value: string) => [apiToken!, updaterToken!].reduce((result, token) => result.split(token).join('[redacted]'), value);
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
let browser: Browser | null = null, page: Page | null = null, failure: unknown = null;
try {
  browser = await chromium.launch({ executablePath: resolveChrome(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  await context.addCookies([
    { name: 'multimira_logged_in', value: '1', url: frontend! }, { name: 'multimira_auth', value: apiToken!, url: frontend!, httpOnly: true },
    { name: 'last_workspace_slug', value: 'local', url: frontend! }, { name: 'multimira-locale', value: 'en', url: frontend! },
  ]);
  await context.addInitScript(token => localStorage.setItem('multimira_token', token), apiToken!);
  page = await context.newPage(); page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(120_000);
  page.on('pageerror', error => jsErrors.push(redact(error.message)));
  page.on('response', response => { if (response.url().startsWith(`${frontend}/api/`) && response.status() >= 500) failures.push(`${new URL(response.url()).pathname} ${response.status()}`); });
  page.on('request', request => { if (request.url().includes('/api/multiremi/platform/') && ['POST', 'PATCH'].includes(request.method())) mutations.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  const configure = async (value: unknown) => {
    const response = await fetch(control!, { method: 'POST', headers: { Authorization: `Bearer ${updaterToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200); await page!.reload({ waitUntil: 'domcontentloaded' });
  };
  await page.goto(`${frontend}/local/settings?tab=platform`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('platform-current-mode').getByText(text.update_modes.images.label, { exact: true }).waitFor();
  check('actual API heartbeat mode is displayed in Web settings');
  // Keep the unrelated floating Chat panel out of the screenshot and pointer path.
  const minimize = page.locator('button').filter({ has: page.locator('svg.lucide-minus') });
  if (await minimize.isVisible()) await minimize.click();
  const before = mutations.length;
  await page.getByRole('button', { name: text.mode_guide, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(text.update_modes.internal_application.migration, { exact: true }).waitFor();
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: text.update_modes.host_application.label, exact: true }).click();
  await dialog.getByText(text.update_modes.host_application.migration, { exact: true }).waitFor();
  await dialog.screenshot({ path: join(artifacts!, 'mode-guide.png'), animations: 'disabled' });
  assert.equal(mutations.length, before, 'Viewing a migration must not send mutations');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  check('mode selection shows corresponding deployment guidance without changing mode or source');

  await configure({ mode: 'internal_application' });
  await page.getByTestId('platform-current-mode').getByText(text.update_modes.internal_application.label, { exact: true }).waitFor();
  const input = page.getByLabel(text.update_source_url, { exact: true });
  await input.fill('https://releases.platform.test/images.json');
  await page.getByText(text.source_unsaved, { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: text.source_check, exact: true }).isDisabled());
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/api/multiremi/platform/settings'));
  await page.getByRole('button', { name: text.source_save, exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.getByRole('button', { name: text.source_check, exact: true }).click();
  await page.getByTestId('platform-source-capabilities').getByText(text.missing_artifacts.application_bundle, { exact: true }).first().waitFor();
  assert(await page.getByRole('button', { name: text.update_now, exact: true }).isDisabled());
  check('saving an image-only source runs real worker checks and blocks internal updates');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input.waitFor();
  assert.equal(await input.inputValue(), 'https://releases.platform.test/images.json');
  check('custom source and incompatibility survive reload');

  await context.addCookies([{ name: 'multimira-locale', value: 'zh-Hans', url: frontend! }]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const preflight = page.getByTestId('platform-preflight');
  await preflight.getByText(zhText.preflight_bundle_unsupported, { exact: true }).waitFor();
  for (const code of ['container_supervisors', 'isolated_rehearsal', 'backup', 'postgresql', 'program_storage', 'release_feed']) {
    assert(await preflight.getByText(zhText.preflight_checks[code].label, { exact: true }).isVisible());
  }
  assert.equal(await preflight.getByText('Release feed is reachable', { exact: true }).count(), 0);
  assert(!/\b(?:AM|PM)\b/.test(await preflight.innerText()), 'Chinese readiness dates must use the UI locale');
  assert(await page.getByRole('button', { name: zhText.update_now, exact: true }).isDisabled());
  await preflight.scrollIntoViewIfNeeded();
  await preflight.screenshot({ path: join(artifacts!, 'preflight-zh-desktop.png'), animations: 'disabled' });
  const cardRadius = await preflight.evaluate(element => getComputedStyle(element).borderRadius);
  for (const id of ['platform-update-mode', 'platform-update-source']) {
    assert.equal(await page.getByTestId(id).evaluate(element => getComputedStyle(element).borderRadius), cardRadius);
  }
  check('Chinese readiness checks and missing-bundle guidance use the shared card style and keep updates blocked');
  await preflight.getByRole('button', { name: zhText.preflight_diagnostics, exact: true }).click();
  await preflight.getByText('container_supervisors', { exact: true }).waitFor();
  assert(await preflight.getByText('This release has no supported application bundle; image-only releases cannot be applied in application mode', { exact: true }).isVisible());
  await preflight.getByRole('button', { name: zhText.preflight_diagnostics, exact: true }).click();
  check('original check codes and failures remain available in expandable diagnostic details');
  await page.setViewportSize({ width: 390, height: 844 });
  await preflight.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Readiness checks overflow at 390px');
  await page.screenshot({ path: join(artifacts!, 'preflight-zh-mobile.png'), animations: 'disabled' });
  check('Chinese check labels, badges and failure guidance fit a 390px viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await context.addCookies([{ name: 'multimira-locale', value: 'en', url: frontend! }]);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await input.fill('https://releases.platform.test/offline.json');
  await page.getByRole('button', { name: text.source_save, exact: true }).click();
  await page.getByRole('button', { name: text.source_check, exact: true }).click();
  await page.getByTestId('platform-source-capabilities').getByText(/Fixture source unavailable/).waitFor();
  assert(await page.getByRole('button', { name: text.update_now, exact: true }).isVisible());
  assert(await page.getByRole('button', { name: text.update_now, exact: true }).isDisabled());
  check('an unreachable source leaves the explicit Web/API update button visible and blocked');

  await page.getByRole('button', { name: text.source_reset, exact: true }).click();
  await page.getByRole('button', { name: text.source_check, exact: true }).click();
  const capabilities = page.getByTestId('platform-source-capabilities');
  await capabilities.getByText(text.source_available, { exact: true }).first().waitFor();
  assert.equal(await capabilities.getByText(text.source_available, { exact: true }).count(), 4);
  assert.equal(await input.inputValue(), '');
  check('restoring the default source rediscovers the unified release for all four modes');
  const updates = page.getByTestId('platform-service-update');
  const update = updates.getByRole('button', { name: text.update_now, exact: true });
  await updates.getByText(text.update_scope, { exact: true }).waitFor();
  await update.click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.getByRole('heading', { name: text.confirm_update_title.replace('{{version}}', '1.0.1'), exact: true }).waitFor();
  assert((await confirmation.innerText()).includes(text.confirm_update_desc));
  await confirmation.getByText(text.update_target_ref.replace('{{ref}}', 'c'.repeat(40)), { exact: true }).waitFor();
  const beforeCancel = mutations.length;
  await confirmation.getByRole('button', { name: text.cancel, exact: true }).click();
  assert.equal(mutations.length, beforeCancel);
  check('the update confirmation names Web/API and the exact target; cancellation sends no operation');
  await update.click();
  const updateResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/multiremi/platform/operations'));
  await confirmation.getByRole('button', { name: text.confirm, exact: true }).click();
  const response = await updateResponse;
  assert.equal(response.status(), 202);
  const payload = response.request().postDataJSON();
  assert.equal(payload.kind, 'update'); assert.equal(payload.targetVersion, '1.0.1');
  assert.equal(payload.targetRef, 'https://releases.platform.test/complete.json');
  await updates.getByText(text.update_no_new_release, { exact: true }).waitFor();
  assert(await update.isVisible()); assert(await update.isDisabled());
  check('the confirmed button reaches the real API and worker, simulates a drained switch, and stays visible after update');
  await updates.screenshot({ path: join(artifacts!, 'web-api-update-entry.png'), animations: 'disabled' });
  await capabilities.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts!, 'update-source-desktop.png'), animations: 'disabled' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: text.mode_guide, exact: true }).click();
  await dialog.waitFor();
  const bounds = await dialog.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.width <= 390 && bounds.height <= 844);
  assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Migration dialog overflows horizontally');
  await page.screenshot({ path: join(artifacts!, 'mode-guide-mobile.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  check('390px migration guidance stays within the viewport and scrolls vertically');

  await configure({ offline: true });
  await page.getByTestId('platform-update-mode').getByText(text.mode_offline, { exact: true }).waitFor();
  await capabilities.getByText(text.source_unchecked, { exact: true }).waitFor();
  await configure({ mode: null });
  await page.getByTestId('platform-current-mode').getByText(text.mode_unknown, { exact: true }).waitFor();
  check('offline and legacy updaters do not imply an active or compatible update mode');
  assert.deepEqual(jsErrors, []); assert.deepEqual(failures, []);
  check('no uncaught browser errors or API 5xx');
} catch (error) {
  failure = error; console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
  if (page) {
    await page.screenshot({ path: join(artifacts!, 'failure.png') }).catch(() => {});
    writeFileSync(join(artifacts!, 'failure-dom.txt'), redact(await page.locator('body').innerText().catch(() => '')));
  }
} finally { await browser?.close(); }
writeFileSync(join(artifacts!, 'browser-report.json'), JSON.stringify({ ok: failure === null, checks, jsErrors, failures, error: failure ? redact(String(failure)) : null }, null, 2));
process.exit(failure === null ? 0 : 1);

function resolveChrome(): string {
  if (process.env.CHROME_EXECUTABLE) { assert(existsSync(process.env.CHROME_EXECUTABLE)); return process.env.CHROME_EXECUTABLE; }
  const caches = [join(homedir(), 'AppData/Local/ms-playwright'), join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')];
  const suffixes = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome', 'chrome-linux/chrome'];
  for (const cache of caches) if (existsSync(cache)) for (const entry of readdirSync(cache).filter(name => name.startsWith('chromium')).sort().reverse()) for (const suffix of suffixes) { const candidate = join(cache, entry, suffix); if (existsSync(candidate)) return candidate; }
  for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (existsSync(candidate)) return candidate;
  throw new Error('No Chromium found; set CHROME_EXECUTABLE');
}
