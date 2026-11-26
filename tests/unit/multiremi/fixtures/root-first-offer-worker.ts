import { PostgresSyncDatabase, type SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { RootReceiptStore } from '@multiremi/store/root-receipts.js';

self.onmessage = async (event: MessageEvent<{file:string;postgres?:string;barrier:SharedArrayBuffer}>) => {
  const {file,postgres,barrier}=event.data;
  const db:SqlDatabase=postgres ? new PostgresSyncDatabase(postgres) : openSqliteDatabase(file);
  try {
    if (!postgres) db.exec('PRAGMA busy_timeout=10000');
    class RacingReceipts extends RootReceiptStore {
      override commitFirstOffer(...args:Parameters<RootReceiptStore['commitFirstOffer']>) {
        const prepared=new Int32Array(barrier);
        if (Atomics.add(prepared,0,1)===0) {
          if (Atomics.wait(prepared,0,1,10000)==='timed-out') throw new Error('second candidate did not reach commit');
        } else Atomics.notify(prepared,0);
        return super.commitFirstOffer(...args);
      }
    }
    const delivery=await new RacingReceipts(db).firstTaskOffer('tsk_admitted','rt_auth','daemon','machine-token','1',()=>{});
    self.postMessage({delivery});
  } catch(error) {self.postMessage({error:error instanceof Error ? error.message : String(error)});}
  finally {db.close();}
};
