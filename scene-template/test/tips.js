'use strict';
// Offline test for the template part of the injected prompt context.
//
//   node test/tips.js
//
// The template governs the output through one tip line: the model is pointed
// at the preview URL, where the real markup and CSS live. The extracted prose
// stays as a fallback (and is marked as an example, so its numbers are not
// copied verbatim).
const assert = require('node:assert');
const mod = require('../lib/index.js');
const t = mod.__test;

const URL = 'https://example.test/preview/project-brief.html';

let passed = 0;
let failed = 0;

/** Run one test. @param name - test name. @param fn - body. */
function test(name, fn) {
	try {
		fn();
		passed += 1;
		console.log('  ok   ' + name);
	} catch (err) {
		failed += 1;
		console.log('  FAIL ' + name + ': ' + (err && err.message ? err.message : err));
	}
}

const selection = { templateTitle: '項目簡報一頁紙', previewUrl: URL };

test('a selected template injects one tips line carrying the preview url', () => {
	const lines = t.templateContextLines(selection, { text: '案例內容', source: 'remote' });
	const tips = lines.filter((line) => line.indexOf('tips:') === 0);
	assert.strictEqual(tips.length, 1, 'expected exactly one tips line, got ' + tips.length);
	assert.ok(tips[0].indexOf(URL) !== -1, 'the tips line must carry the preview url');
});

test('the tips line tells the model to follow the template, not the sample numbers', () => {
	const lines = t.templateContextLines(selection, { text: '案例內容', source: 'remote' });
	const tips = lines.filter((line) => line.indexOf('tips:') === 0)[0];
	assert.ok(tips.indexOf('模板和樣式') !== -1, 'the tips line must ask for the template and its styles');
	assert.ok(lines.join('\n').indexOf('僅為範例') !== -1, 'the extracted prose must be marked as an example');
});

test('an inline data: template gets no tip line (there is no url to follow)', () => {
	const lines = t.templateContextLines(
		{ templateTitle: '內建範例', previewUrl: 'data:text/html;base64,PGI+PGgxPmhlbGxvPC9oMT4=' },
		{ text: '案例內容', source: 'inline' },
	);
	assert.strictEqual(lines.filter((line) => line.indexOf('tips:') === 0).length, 0);
});

test('a template without cached content still points at the preview', () => {
	const lines = t.templateContextLines(selection, undefined);
	assert.ok(lines.join('\n').indexOf(URL) !== -1, 'the preview url must survive a missing cache entry');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
