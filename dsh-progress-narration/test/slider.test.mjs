import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function findElement(node, matches) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'function') return findElement(node.type(node.props), matches);
  if (matches(node)) return node;
  for (const child of node.children) {
    const match = findElement(child, matches);
    if (match) return match;
  }
}

function mountSlider() {
  // Load the registered slots and observe writes at the host settings boundary.
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    createRef: () => ({ current: null }),
    useRef: (current) => ({ current }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };
  const modules = {
    react,
    'react-dom': { createPortal: (node) => node },
    '@deepseek-ai/dsh-client-ui-primitives': {
      MenuSurface: 'dialog',
      useAnchoredPosition: () => ({ top: 10, left: 10 }),
    },
  };
  const slots = new Map();
  const writes = [];
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { mode: 'balanced' } }),
    set: (field, value) => writes.push([field, value]),
  };
  const load = ({ factory }) => factory((name) => modules[name]).apply({
    slots: {
      inject: (_name, register) => register(),
      register: ({ name }, component) => slots.set(name, component),
    },
    configForms: { get: () => form },
  });
  runInNewContext(source, { window: { __ModuleLoader__: { load } }, document: { body: {} } });

  const trigger = findElement(slots.get('conversation.input.right')(), (node) => node.type === 'button');
  trigger.props.onClick();
  const slider = findElement(slots.get('shell.overlay')(), (node) => node.props?.role === 'slider');
  const captures = new Set();
  const track = {
    getBoundingClientRect: () => ({ left: 100, width: 306 }),
    focus() {},
    setPointerCapture: (id) => captures.add(id),
    hasPointerCapture: (id) => captures.has(id),
    releasePointerCapture: (id) => captures.delete(id),
  };
  slider.props.ref.current = track;
  const content = slider.children.find((node) => node.props.ref);
  if (content) content.props.ref.current = { getBoundingClientRect: () => ({ left: 103, width: 300 }) };

  const pointer = (handler, pointerId, clientX) => slider.props[handler]({
    currentTarget: track, button: 0, pointerId, clientX, preventDefault() {},
  });
  return { pointer, writes, captures };
}

test('only the initiating pointer can move, cancel or commit the drag', () => {
  const { pointer, writes, captures } = mountSlider();
  pointer('onPointerDown', 1, 253);
  pointer('onPointerMove', 1, 353);
  pointer('onPointerDown', 2, 153);
  pointer('onPointerMove', 2, 153);
  pointer('onPointerUp', 2, 153);
  pointer('onPointerCancel', 2, 153);
  pointer('onLostPointerCapture', 2, 153);
  assert.deepEqual(writes, []);
  assert.deepEqual([...captures], [1]);

  pointer('onPointerUp', 1, 353);
  pointer('onLostPointerCapture', 1, 353);
  assert.deepEqual(writes, [['mode', 'chatty']]);
  assert.equal(captures.size, 0);
});

test('cancel discards the preview and a subsequent click can still choose a mode', () => {
  const { pointer, writes, captures } = mountSlider();
  pointer('onPointerDown', 1, 253);
  pointer('onPointerMove', 1, 353);
  pointer('onPointerCancel', 1, 353);
  pointer('onPointerUp', 1, 353);
  assert.deepEqual(writes, []);
  assert.equal(captures.size, 0);

  pointer('onPointerDown', 2, 153);
  pointer('onPointerUp', 2, 153);
  assert.deepEqual(writes, [['mode', 'gentle']]);
});
