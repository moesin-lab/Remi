import { randomUUID } from 'node:crypto';
import { birth } from './root-run-supervisor.mjs';

export class RootRunController {
  #owner;
  #retired = new Set();
  #start;
  #queue = Promise.resolve();

  dispatch(operation, answer) {
    if (operation === 'attest') return answer();
    const response = this.#queue.then(answer);
    this.#queue = response.catch(() => {});
    return response;
  }

  check(request) {
    if (!request.controller || this.#retired.has(request.controller) || birth(request.pid) !== request.birth) throw Error();
  }

  attach(request) {
    this.check(request);
    const owner = this.#owner;
    const sameFence = owner?.lease === request.lease && owner?.term === request.term;
    if (owner?.controller === request.controller && owner.birth === request.birth && sameFence) return owner.generation;
    if (owner && owner.controller !== request.controller) {
      if (sameFence) {
        try { if (birth(owner.pid) === owner.birth) throw Error('controller still alive'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.#retired.add(owner.controller);
    }
    this.#owner = { controller: request.controller, term: request.term, lease: request.lease,
      generation: randomUUID(), pid: request.pid, birth: request.birth };
    return this.#owner.generation;
  }

  startOnce(request, release) {
    this.check(request);
    const owner = this.#owner;
    if (!owner || owner.controller !== request.controller || owner.generation !== request.generation ||
        owner.birth !== request.birth || owner.lease !== request.lease || owner.term !== request.term) throw Error();
    this.#start ??= Promise.resolve().then(release);
    return this.#start;
  }
}
