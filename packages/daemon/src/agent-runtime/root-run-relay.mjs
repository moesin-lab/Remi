import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { approvedJson, trustedPath } from './root-run-approved.mjs';
import { checkServiceDirectory, serviceRequest } from './root-run-endpoint.mjs';

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
      const plans = approvedJson(approvedPlansFile).plans.filter(plan => isDeepStrictEqual(plan.tuple, tuple));
      if (plans.length !== 1) throw Error('ambiguous or missing run approval');
      const { uid, gid, file, args, cwd, sha256 } = plans[0];
      trustedPath(file);
      trustedPath(cwd, true);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(file)) digest.update(chunk);
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string') || digest.digest('hex') !== sha256) throw Error('unapproved executable');
      return { uid, gid, file, args, cwd };
    },
  };
}
