import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { approvedJson, trustedPath } from './root-run-approved.mjs';
import { checkServiceDirectory, serviceRequest } from './root-run-endpoint.mjs';

const bindingStrings = ['consumer_id', 'runtime_id', 'daemon_id', 'incarnation', 'recipient_key_id', 'recipient_key_fingerprint', 'grant_id', 'execution_digest'];
const bindingGenerations = ['grant_generation', 'execution_config_epoch'];

function registeredPlan(plan, tuple) {
  if ('tuple' in plan) return !('binding' in plan) && isDeepStrictEqual(plan.tuple, tuple);
  const binding = plan.binding;
  if (!binding || !bindingStrings.every(key => typeof binding[key] === 'string' && binding[key].trim().length > 0) ||
      !Number.isSafeInteger(binding.grant_generation) || binding.grant_generation <= 0 ||
      !Number.isSafeInteger(binding.execution_config_epoch) || binding.execution_config_epoch < 0) return false;
  const expected = Object.fromEntries([...bindingStrings, ...bindingGenerations].map(key => [key, tuple[key]]));
  return isDeepStrictEqual(binding, expected);
}

export function rootRunHost({ daemonUid, hostSocket, approvedPlansFile }) {
  if (basename(hostSocket) !== 'host.sock') throw Error('invalid daemon host endpoint');
  checkServiceDirectory(dirname(hostSocket), daemonUid);
  const relay = fields => serviceRequest({ endpoint: hostSocket, supervisorUid: daemonUid }, fields);
  return {
    readStatus: tuple => relay({ op: 'status', tuple }),
    sealInstallation: (target, status) => relay({ op: 'seal', target, status }),
    verifyInstallation(_target, sealed, proof) {
      if (!/^[a-f0-9]{64}$/.test(sealed.verificationId) || typeof proof !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(proof)) return false;
      return timingSafeEqual(createHash('sha256').update(proof, 'ascii').digest(), Buffer.from(sealed.verificationId, 'hex'));
    },
    async planRun(tuple, status) {
      if (!isDeepStrictEqual(status.tuple, tuple)) throw Error('unapproved run');
      const plans = approvedJson(approvedPlansFile).plans.filter(plan => registeredPlan(plan, tuple));
      if (plans.length !== 1) throw Error('ambiguous or missing run approval');
      const { uid, gid, identities, file, args, cwd, sha256 } = plans[0];
      const pool = 'tuple' in plans[0] && identities === undefined ? [{ uid, gid }] : identities;
      if (!Array.isArray(pool) || !pool.length || identities !== undefined && (uid !== undefined || gid !== undefined) ||
          pool.some(identity => !identity || ![identity.uid, identity.gid].every(id => Number.isSafeInteger(id) && id > 0 && id < 0xffffffff && id !== 65534)) ||
          new Set(pool.map(identity => identity.uid)).size !== pool.length || new Set(pool.map(identity => identity.gid)).size !== pool.length) throw Error('invalid execution identity pool');
      trustedPath(file);
      trustedPath(cwd, true);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(file)) digest.update(chunk);
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string') || digest.digest('hex') !== sha256) throw Error('unapproved executable');
      return { identities: pool, file, args, cwd, sha256 };
    },
  };
}
