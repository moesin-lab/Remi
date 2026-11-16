/** Copied into each ref's tests/ tree; never a production build entrypoint. */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MultiremiDaemon } from '@multiremi/daemon.js';
import { AcpProvider } from '@acp/provider.js';
import { version } from '../../../package.json';

if (process.env.NODE_ENV !== 'test' || process.env.MULTIREMI_UPGRADE_HARNESS !== '1') throw new Error('Test-only daemon requires explicit harness opt-in');
const root = process.env.MULTIREMI_STATE_DIR!;
const control = process.env.MULTIREMI_HARNESS_CONTROL_DIR ?? '/control';
// Structurally valid, deliberately unusable native-auth fixture. No real provider is invoked.
const fakeHome = join(homedir(), '.codex');
await mkdir(fakeHome, { recursive: true });
await writeFile(join(fakeHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-upgrade-harness', refresh_token: 'fake-upgrade-harness' } }), { mode: 0o600 });
const daemon = new MultiremiDaemon({
  serverUrl: process.env.MULTIREMI_SERVER_URL!, token: process.env.MULTIREMI_TOKEN!,
  daemonId: 'upgrade-harness', runtimeName: 'Isolated upgrade harness', provider: 'codex', workspaceId: 'local',
  daemonPort: Number(process.env.MULTIREMI_DAEMON_PORT), pollIntervalMs: 50, gcEnabled: false,
  workspacesRoot: join(root, 'workspaces'), repoCacheRoot: join(root, 'cache'), pluginCacheRoot: join(root, 'plugins'),
  protocolClientOptions: { cliVersion: version },
  sshMeshManager: { getHeartbeatStatus: () => ({ status: 'disabled' }), reconcile: async () => {}, cleanupForRetirement: async () => {} },
  agentPluginProviderPreflight: async () => {},
  providerFactory: options => new AcpProvider({ ...options, agentType: 'codex', executable: process.execPath,
    args: [process.env.MULTIREMI_HARNESS_FAKE_ACP ?? '/fixture/fake-steering-agent.ts'], privateTmpDirectory: undefined,
    env: { ...options.env, BUN_BE_BUN: '1', FAKE_STEER_LOG: join(control, 'provider.jsonl'), FAKE_STEER_CONTROL: join(control, 'release'),
      FAKE_STEER_CONFIG: JSON.stringify({ advertise: 'codex', prompts: [{ chunks: ['UPGRADE_HARNESS_OK'], tool: { ms: null }, hold: 'control', tickMs: 100 }] }) },
  }),
});
process.on('SIGTERM', () => { daemon.stop(); });
await daemon.start();
