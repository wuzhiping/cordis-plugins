'use strict';

// Dev helper: subscribe to the host's /plugins/events SSE channel and print
// the frames it broadcasts, so a change to a client bundle can be observed
// live instead of guessed at.
//
//   node test/dev-events.js            # watch until Ctrl+C
//   node test/dev-events.js 8000       # watch for 8 seconds, then exit
//
// The channel is the node half of @deepseek-ai/dsh-client-hmr: it stat-polls
// each graph bundle every pollIntervalMs (default 500) and broadcasts a
// `rebuilt` frame when a bundle's revision changes. The browser half turns
// that frame into an in-place plugin swap with no page reload.

const BASE = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const ms = Number(process.argv[2] || 0);

async function main() {
  const res = await fetch(BASE + '/plugins/events', {
    headers: { accept: 'text/event-stream' },
  });
  console.log('GET /plugins/events -> ' + res.status + ' ' + (res.headers.get('content-type') || ''));
  if (!res.ok || !res.body) {
    console.error('no SSE stream; the HMR node half may be disabled');
    process.exit(1);
  }

  const started = Date.now();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const stop = ms > 0 ? setTimeout(() => { reader.cancel().catch(() => {}); }, ms) : null;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const t = ((Date.now() - started) / 1000).toFixed(2);
        const lines = block.split('\n');
        const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim();
        const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        let summary = data;
        try {
          const parsed = JSON.parse(data);
          // Keep the printout to the fields that matter during a dev loop.
          summary = JSON.stringify({
            id: parsed.id,
            rev: parsed.rev,
            graphRev: parsed.graphRev || (parsed.rev && parsed.entries ? parsed.rev : undefined),
            entries: parsed.entries ? parsed.entries.length : undefined,
          });
        } catch (_) { /* not JSON; print raw */ }
        console.log('[' + t + 's] ' + (event || 'message') + '  ' + summary);
      }
    }
  } catch (err) {
    if (!/cancel/i.test(String(err && err.message))) throw err;
  } finally {
    if (stop) clearTimeout(stop);
  }
  console.log('watch ended');
}

main().catch((err) => { console.error(err); process.exit(1); });
