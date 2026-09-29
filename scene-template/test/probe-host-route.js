'use strict';
// Is scene-template's selection route reachable? Compares the OLD path (inside the
// framework's `/plugins` prefix tree) with the NEW one, and the framework's own
// prefix route as a control.
//
//   node test/probe-host-route.js
//
// The distinction is in the response: the plugin's own handler always answers JSON
// with a content-type header, while the framework's plugin-asset handler answers a
// bare 405/404 and the SPA fallback answers the index HTML.
const BASE = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const TARGETS = [
  ['new route (host half)', BASE + '/scene-template/selection'],
  ['old route (inside /plugins)', BASE + '/plugins/scene-template/selection'],
  ['control: /plugins asset carrier', BASE + '/plugins/scene-template/client.js'],
];
const CALLS = [
  ['GET', { method: 'GET' }],
  ['POST {}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ['POST selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'route-probe', selection: null }),
  }],
];

async function probe(url, label, init) {
  try {
    const res = await fetch(url, init);
    const type = res.headers.get('content-type') || '';
    const text = type.indexOf('json') !== -1 ? await res.text() : '';
    return { status: res.status, type: type.split(';')[0], body: text.slice(0, 110) };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

(async () => {
  for (const [name, url] of TARGETS) {
    console.log('== ' + name + '  ' + url);
    for (const [label, init] of CALLS) {
      const r = await probe(url, label, init);
      let verdict = '';
      if (r.error) verdict = r.error;
      else if (r.type === 'application/json') verdict = 'PLUGIN HANDLER RAN (json)';
      else if (r.type === 'text/html') verdict = 'SPA fallback (route not registered)';
      else if (r.status === 405) verdict = 'framework asset route (405, no content-type)';
      else if (r.status === 404) verdict = 'framework asset route (404, no content-type)';
      console.log('   ' + label.padEnd(16) + ' -> ' + JSON.stringify(r) + '   ' + verdict);
    }
    console.log('');
  }
  console.log('A JSON response means the scene-template host half is live; anything else');
  console.log('means it is not (a host-side change needs a `dsh web` restart to load).');
})();
