import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = join(repository, 'deploy/windows/run-platform-updater.ps1');
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

test('Windows updater runners share one configuration mutex and release it after the child exits', { skip: process.platform !== 'win32', timeout: 90_000 }, async (t) => {
  const temporaryParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryParent, 'remi-runner-mutex-test-'));
  const fixture = join(root, 'mock-updater.ps1');
  const config = join(root, 'updater.env');
  const marker = join(root, 'starts.log');
  const release = join(root, 'release');
  const processes = [];
  t.after(async () => {
    // Always release a waiting fixture before cleanup; never target a real
    // updater process or a scheduled task.
    writeFileSync(release, 'release');
    await Promise.all(processes.map((child) => child.completion));
    const target = realpathSync(root);
    assert.equal(dirname(target), temporaryParent);
    assert.match(target.slice(temporaryParent.length + 1), /^remi-runner-mutex-test-[^/\\]+$/u);
    rmSync(target, { recursive: true, force: true });
  });
  writeFileSync(fixture, [
    '[IO.File]::AppendAllText($env:TEST_UPDATER_MARKER, "started`n")',
    '$deadline = (Get-Date).AddSeconds(60)',
    'while (-not (Test-Path -LiteralPath $env:TEST_UPDATER_RELEASE)) {',
    '  if ((Get-Date) -gt $deadline) { exit 99 }',
    '  Start-Sleep -Milliseconds 20',
    '}',
    'exit 7',
  ].join('\n'));
  writeFileSync(config, `TEST_UPDATER_MARKER=${marker}\nTEST_UPDATER_RELEASE=${release}\n`);

  function start(configPath) {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Executable', fixture, '-Config', configPath], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const completion = new Promise((resolveCompletion, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolveCompletion({ code, signal, output }));
    });
    const tracked = { child, completion };
    processes.push(tracked);
    return tracked;
  }

  const first = start(config);
  // Cold Windows PowerShell startup can exceed 10 seconds on hosted runners.
  // Keep the fixture alive long enough to prove exclusivity and subsequent release.
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker) && Date.now() < deadline) {
    if (first.child.exitCode !== null) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  if (!existsSync(marker)) {
    const result = await first.completion;
    assert.fail(`The first fixture did not start: ${result.output}`);
  }
  // Windows casing and relative-dot aliases must identify the same file.
  const second = start(join(root, '.', 'updater.env').toUpperCase());
  const secondResult = await second.completion;
  assert.equal(secondResult.code, 0, secondResult.output);
  assert.equal(first.child.exitCode, null, 'the first runner still owns the updater lifecycle');
  assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'a competing runner must not launch its updater');

  writeFileSync(release, 'release');
  const firstResult = await first.completion;
  assert.equal(firstResult.code, 7, firstResult.output);
  const thirdResult = await start('.\\updater.env').completion;
  assert.equal(thirdResult.code, 7, thirdResult.output);
  assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 2, 'the mutex is available again after the owning child exits');
});
