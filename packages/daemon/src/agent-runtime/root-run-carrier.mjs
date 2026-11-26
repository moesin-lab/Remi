import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { compactDecrypt } from 'jose';

export function serveParkedReceiver() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  process.send({ publicKey: publicKey.export({ format: 'jwk' }) });
  let env;
  let model;
  let consumed = false;
  function finish() {
    model?.kill('SIGKILL');
    process.exit();
  }
  process.on('disconnect', finish);
  process.on('SIGTERM', finish);
  process.on('message', async request => {
    try {
      if (request.op === 'probe') return process.send({ id: request.id, nonce: request.nonce });
      if (request.op === 'install') {
        const { plaintext, protectedHeader } = await compactDecrypt(request.envelope, privateKey, {
          keyManagementAlgorithms: ['RSA-OAEP-256'], contentEncryptionAlgorithms: ['A256GCM'],
        });
        const payload = JSON.parse(Buffer.from(plaintext).toString());
        const { tuple, locator } = request.target;
        if (protectedHeader.kid !== locator.birth_token_id || !isDeepStrictEqual(payload.target, request.target) ||
            typeof payload.raw !== 'string' || !payload.raw || typeof payload.turnId !== 'string' || !payload.turnId ||
            typeof payload.nonce !== 'string' || !payload.nonce) throw Error();
        const installed = { MULTIREMI_TOKEN: payload.raw, MULTIREMI_TURN_ID: payload.turnId, MULTIREMI_ATTEMPT_ID: tuple.attempt_id,
          MULTIREMI_ROOT_CARRIER: 'immutable_run_env', MULTIREMI_ROOT_RECEIPT_ID: tuple.receipt_id,
          MULTIREMI_ROOT_RUN_GENERATION: String(tuple.run_generation), MULTIREMI_ROOT_DELIVERY_VERSION: String(tuple.delivery_version) };
        if (env && !isDeepStrictEqual(env, installed)) throw Error();
        env = Object.freeze(installed);
        const message = ['remi.root.install.v1', payload.nonce, tuple.receipt_id, tuple.attempt_id, tuple.delivery_version,
          tuple.run_generation, locator.launch_identity];
        return process.send({ id: request.id, proof: createHmac('sha256', payload.raw).update(JSON.stringify(message)).digest('base64url') });
      }
      if (request.op !== 'start' || consumed || !env) throw Error();
      consumed = true;
      model = spawn(request.launch.file, request.launch.args, { cwd: request.launch.cwd, env, stdio: 'ignore' });
      model.once('exit', finish);
      model.once('error', finish);
      model.once('spawn', () => process.send({ id: request.id, started: true }));
    } catch { process.send({ id: request.id, failed: true }); }
  });
}
