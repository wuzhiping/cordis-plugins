'use strict';

// Fetch the FDEP docs for one api id, straight from the endpoint, so the
// field descriptions (and any type hints in them) can be inspected without
// going through the GUI.
//
//   node test/fdep-docs.js twseMops.todayMaterial
//   node test/fdep-docs.js twseMops.todayMaterial --raw

const URL = 'https://abc.feg.com.tw/oauth2/fdep';

async function main() {
  const apiId = process.argv[2];
  if (!apiId) {
    console.error('usage: node test/fdep-docs.js <api_id> [--raw]');
    process.exit(2);
  }
  const raw = process.argv.includes('--raw');

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api: apiId, do: false, inbound: {} }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { _raw: text }; }

  console.log('status   : ' + res.status);
  console.log('trace_id : ' + (parsed.trace_id || '(none)'));
  console.log('');

  if (raw) {
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  const docs = parsed && parsed.data && parsed.data.docs;
  if (!docs) {
    console.log('no data.docs in the response:');
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  console.log('raw docs:');
  console.log(JSON.stringify(docs, null, 2));
  console.log('');
  console.log('split (desc vs parameters):');
  for (const [k, v] of Object.entries(docs)) {
    const role = k === 'desc' ? 'DESC ' : 'PARAM';
    const type = Array.isArray(v) ? 'array' : typeof v;
    console.log('  ' + role + '  ' + k.padEnd(22) + ' (' + type + ')  ' + JSON.stringify(v));
  }
}

main().catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; });
