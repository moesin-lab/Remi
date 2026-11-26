import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const [root, url, role] = process.argv.slice(2);
async function patch(name) {
  const response = await fetch(url, { method:'PATCH', headers: { authorization:`Bearer ${process.env.MULTIREMI_TOKEN}`,
    'content-type':'application/json' }, body: JSON.stringify({ name }) });
  await response.text();
  return response.status;
}
if (role === 'copy') {
  for await (const line of createInterface({input:process.stdin})) console.log(await patch(JSON.parse(line)));
} else {
  appendFileSync(`${root}/execution/launches`, `${process.pid}\n`);
  const socket = connect(`${root}/model.sock`);
  const send = value => socket.write(JSON.stringify(value) + '\n');
  const child = spawn(process.execPath, [process.argv[1], root, url, 'copy'], {stdio:['pipe','pipe','ignore']});
  const copyReplies = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  send({ pid:process.pid, uid:process.getuid(), version:process.env.MULTIREMI_ROOT_DELIVERY_VERSION });
  for await (const line of createInterface({input:socket})) {
    const command = JSON.parse(line);
    if (command.copy) {
      child.stdin.write(JSON.stringify(command.name) + '\n');
      const reply = await copyReplies.next();
      if (reply.done) throw Error('Replica exited');
      send({ pid:child.pid, status:Number(reply.value) });
    } else if (command.question) {
      send({ turn_id:process.env.MULTIREMI_TURN_ID, attempt_id:process.env.MULTIREMI_ATTEMPT_ID,
        wait_id:'guest-wait', dedupe_key:'guest-wait', body_md:'Continue the restored execution?', options:[{label:'Yes',value:'yes'}],
        metadata:{kind:'question',questions:[{question:'Continue?',options:[{label:'Yes'}]}]} });
    } else send({ pid:process.pid, status:await patch(command.name) });
  }
  child.stdin.end();
}
