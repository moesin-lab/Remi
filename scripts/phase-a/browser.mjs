// Chromium's native WebSocket, with the same auth/stream protocol as TraceSocket.
export async function openTraceBrowser(config, token, attemptId, turnId) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: config.chromeExecutable, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(config.baseUrl + '/readyz');
    await page.evaluate(({ token, attemptId, turnId }) => {
      const state = { connections: 0, reconnects: 0, connectionErrors: 0, acks: 0, wsFrames: 0, gaps: 0,
        head: 0, complete: false, httpPages: 0, errors: [] };
      const seen = new Set();
      let stopped = false, socket, timer;
      const connect = () => {
        if (stopped) return;
        socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/api/trace/ws');
        socket.onopen = () => {
          if (state.connections++) state.reconnects++;
          socket.send(JSON.stringify({ type: 'auth', payload: { token } }));
        };
        socket.onmessage = event => {
          try {
            const frame = JSON.parse(event.data), p = frame.payload;
            if (frame.type === 'auth_ack') socket.send(JSON.stringify({ type: 'stream.subscribe', payload: { stream: 'trace', id: attemptId, from_seq: 1 } }));
            if (frame.type === 'stream.ack') { state.acks++; if (p.gap) state.gaps++; }
            if (frame.type === 'stream.gap') state.gaps++;
            if (frame.type === 'stream.error') state.errors.push('stream.error:' + p.code);
            if (frame.type === 'stream.data') for (const row of p.frames) { seen.add(row.seq); state.wsFrames++; }
          } catch { state.errors.push('invalid_ws_frame'); }
        };
        socket.onerror = () => state.connectionErrors++;
        socket.onclose = () => { if (!stopped) timer = setTimeout(connect, 250); };
      };
      window.mul172 = {
        snapshot: () => ({ ...state }),
        stop: () => { stopped = true; clearTimeout(timer); socket?.close(); },
        repair: async () => {
          let after = 0;
          for (let count = 0; count < 10000; count++) {
            const response = await fetch(`/api/turns/${encodeURIComponent(turnId)}/trace?view=events&attempt_id=${encodeURIComponent(attemptId)}&after_seq=${after}&limit=1000`,
              { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error('trace_http_' + response.status);
            const page = await response.json();
            if (!Array.isArray(page.events) || !Number.isSafeInteger(page.head) || page.head < 1) throw new Error('trace_page_invalid');
            state.httpPages++;
            for (const event of page.events) seen.add(event.seq);
            state.head = page.head;
            if (page.eof) {
              state.complete = page.closed === true;
              for (let seq = 1; seq <= page.head; seq++) if (!seen.has(seq)) state.complete = false;
              return { ...state, receivedSequences: seen.size };
            }
            if (!Number.isSafeInteger(page.next_after_seq) || page.next_after_seq <= after) throw new Error('trace_cursor_stalled');
            after = page.next_after_seq;
          }
          throw new Error('trace_pagination_limit');
        },
      };
      connect();
    }, { token, attemptId, turnId });
    await page.waitForFunction(() => window.mul172.snapshot().acks > 0, undefined, { timeout: 30000 });
    return { finish: () => page.evaluate(() => window.mul172.repair()),
      close: async () => { await page.evaluate(() => window.mul172.stop()).catch(() => {}); await browser.close(); } };
  } catch (error) { await browser.close(); throw error; }
}
