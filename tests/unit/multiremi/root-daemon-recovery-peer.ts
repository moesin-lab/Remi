import { createInterface } from 'node:readline';
import { acknowledgeRunEnvironment, type InstallChallenge } from '@multiremi/worker/root-run-installation.js';

const [url] = process.argv.slice(2);
const birthToken = crypto.randomUUID();
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { challenge: InstallChallenge } | { name: string };
  if ('challenge' in command) {
    console.log(JSON.stringify({ pid: process.pid, birthToken, proof: acknowledgeRunEnvironment(command.challenge) }));
  } else {
    const response = await fetch(url, { method: 'PATCH', headers: {
      authorization: `Bearer ${process.env.MULTIREMI_TOKEN}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ name: command.name }) });
    await response.text();
    console.log(JSON.stringify({ pid: process.pid, birthToken, status: response.status }));
  }
}
