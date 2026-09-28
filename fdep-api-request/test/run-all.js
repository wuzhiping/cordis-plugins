'use strict';

// Runs every fdep-api-request-bundle test in order and reports a summary.
//
//   node test/run-all.js
//
// Each test is a separate process so a crash in one cannot mask another.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TESTS = [
  {
    file: 'host-integration.test.js',
    title: 'host — real cordis + dsh-tools registry + execute pipeline',
    needsDsh: true,
  },
  {
    file: 'host-http.test.js',
    title: 'host — real webserver: the arm route answers, the assembler injects',
    needsDsh: true,
  },
  {
    file: 'host-shape.test.js',
    title: 'host — plugin shape contract (pins the two silent traps)',
    needsDsh: true,
  },
  {
    file: 'host-localhost.test.js',
    title: 'host — dependency-free unit checks (mocked ctx)',
    needsDsh: false,
  },
  {
    file: 'client-contract.test.js',
    title: 'client — loader wrapper, slot contract, rendered component',
    needsDsh: false,
  },
  {
    file: 'preview.js',
    title: 'preview — regenerates preview.html and validates the markup',
    needsDsh: false,
  },
];

let failed = 0;
let skipped = 0;

for (const test of TESTS) {
  const full = path.join(__dirname, test.file);
  console.log('\n' + '='.repeat(72));
  console.log(test.title);
  console.log('='.repeat(72));

  const res = spawnSync(process.execPath, [full], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });

  if (res.status === 2 && test.needsDsh) {
    console.log('-> SKIPPED (DSH installation not found)');
    skipped += 1;
  } else if (res.status !== 0) {
    console.log('-> FAILED (exit ' + res.status + ')');
    failed += 1;
  } else {
    console.log('-> PASSED');
  }
}

console.log('\n' + '='.repeat(72));
console.log(
  failed === 0
    ? 'ALL TESTS PASSED' + (skipped ? ' (' + skipped + ' skipped)' : '')
    : failed + ' TEST FILE(S) FAILED',
);
console.log('='.repeat(72));

process.exit(failed === 0 ? 0 : 1);
