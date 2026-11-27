interface ControllerIdentity {
  controller: string;
  lease: string;
  term: string;
  pid: number;
  birth: string;
}

export class RootRunController {
  dispatch<T>(operation: string, answer: () => Promise<T>): Promise<T>;
  check(request: ControllerIdentity): void;
  attach(request: ControllerIdentity): string;
  startOnce<T>(request: ControllerIdentity & { generation: string }, release: () => T | Promise<T>): Promise<T>;
}
