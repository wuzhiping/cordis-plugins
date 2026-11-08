/**
 * 過程播報「切檔回彈」回歸測試：
 * 模擬一個很慢的設定寫入，驗證點擊後膠囊停在目標檔位、不會先彈回舊檔位；
 * 只有主機確認（快照更新）或寫入被拒絕時才改變視覺位置。
 *
 * 執行：node --test（在插件目錄）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/* ── 迷你 React：支援 useState/useRef/useEffect（含 deps），按元件路徑保存 hook ── */
function createRenderer() {
  const instances = new Map();
  let cursor = null;
  let scheduled = false;

  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
  const createRef = () => ({ current: null });
  const schedule = () => {
    scheduled = true;
  };

  function slotStore() {
    const { store } = cursor;
    const index = cursor.i++;
    while (store.hooks.length <= index) store.hooks.push({});
    return store.hooks[index];
  }

  function useState(initial) {
    const slot = slotStore();
    if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial;
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      schedule();
    }];
  }

  function useRef(initial) {
    const slot = slotStore();
    if (!('ref' in slot)) slot.ref = { current: initial };
    return slot.ref;
  }

  function sameDeps(left, right) {
    if (left === undefined || right === undefined) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => Object.is(value, right[index]));
  }

  function useEffect(effect, deps) {
    const slot = slotStore();
    if ('deps' in slot && sameDeps(slot.deps, deps)) return;
    if (typeof slot.cleanup === 'function') slot.cleanup();
    slot.deps = deps;
    slot.cleanup = effect();
  }

  const React = { createElement, createRef, useRef, useState, useEffect };

  function hostElement(node) {
    return {
      type: node.type,
      props: node.props ?? {},
      children: [],
      focus() {},
      contains: () => false,
      setPointerCapture() {},
      hasPointerCapture: () => false,
      releasePointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 34 }),
    };
  }

  function render(node, path) {
    if (Array.isArray(node)) return node.map((child, index) => render(child, path + '/' + index));
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const key = path + '#' + (node.type.name || 'component');
      const store = instances.get(key) ?? { hooks: [] };
      instances.set(key, store);
      const previous = cursor;
      cursor = { store, i: 0 };
      let rendered;
      try {
        rendered = node.type(node.props ?? {});
      } finally {
        cursor = previous;
      }
      return render(rendered, key);
    }
    const element = hostElement(node);
    element.children = (node.children ?? []).map((child, index) => render(child, path + '/' + index));
    if (element.props.ref !== undefined && element.props.ref !== null) element.props.ref.current = element;
    return element;
  }

  return {
    React,
    /** 反覆渲染直到沒有待處理的狀態更新。 */
    renderTree(node) {
      for (let round = 0; round < 30; round += 1) {
        scheduled = false;
        const tree = render(node, 'root');
        if (!scheduled) return tree;
      }
      throw new Error('渲染未收斂');
    },
  };
}

function findAll(node, predicate, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.type !== 'function' && predicate(node)) out.push(node);
  if (node.children) findAll(node.children, predicate, out);
  return out;
}

/** 裝載插件、可控制設定讀寫時機的測試環境。 */
function mount() {
  const renderer = createRenderer();
  const slots = new Map();
  const listeners = new Set();
  const writes = [];
  const timers = [];
  let value = { mode: 'balanced' };

  const form = {
    getSnapshot: () => ({ status: 'ready', value }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (field, next) => new Promise((resolve) => {
      writes.push({ field, value: next, resolve });
    }),
  };

  const modules = {
    react: renderer.React,
    'react-dom': { createPortal: (node) => node },
    '@deepseek-ai/dsh-client-ui-primitives': {
      MenuSurface: 'dialog',
      useAnchoredPosition: () => ({ top: 10, left: 10 }),
    },
  };
  const load = ({ factory }) => factory((name) => modules[name]).apply({
    effect: (callback) => {
      callback();
    },
    slots: {
      inject: (_name, register) => register(),
      register: ({ name }, component) => slots.set(name, component),
    },
    configForms: { get: () => form },
  });
  runInNewContext(source, {
    window: { __ModuleLoader__: { load }, addEventListener: () => {}, removeEventListener: () => {} },
    document: { body: {}, addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    console,
  });

  /** 宿主接受新設定後，快照更新並通知訂閱者。 */
  const hostRefresh = (mode) => {
    value = { mode };
    listeners.forEach((listener) => listener());
  };

  return { renderer, slots, writes, timers, hostRefresh };
}

/** 打開面板並回傳目前渲染出來的滑桿元素。 */
function openPanel(renderer, slots) {
  const triggerRoot = { type: slots.get('conversation.input.right'), props: {}, children: [] };
  const triggerTree = renderer.renderTree(triggerRoot);
  const button = findAll(triggerTree, (node) => node.type === 'button')[0];
  button.props.onClick();
  renderer.renderTree(triggerRoot);

  const overlayRoot = { type: slots.get('shell.overlay'), props: {}, children: [] };
  const overlayTree = renderer.renderTree(overlayRoot);
  const slider = findAll(overlayTree, (node) => node.props?.role === 'slider')[0];
  // 讓點擊座標換算有穩定幾何：左緣 103、寬 300（三檔各 100）。
  const segments = findAll(slider, (node) => node.props?.className === 'pnn-segments')[0];
  segments.getBoundingClientRect = () => ({ left: 103, top: 0, width: 300, height: 34 });
  return { triggerRoot, overlayRoot, slider };
}

function pointerEvent(track, clientX) {
  return {
    currentTarget: track,
    button: 0,
    pointerId: 1,
    clientX,
    preventDefault() {},
    stopPropagation() {},
  };
}

/** 點擊某一檔（三檔各 100 寬，左緣 103）。 */
function clickSegment(renderer, overlayRoot, slider, segmentIndex) {
  const event = pointerEvent(slider, 103 + segmentIndex * 100 + 50);
  slider.props.onPointerDown(event);
  slider.props.onPointerUp(event);
  const tree = renderer.renderTree(overlayRoot);
  return findAll(tree, (node) => node.props?.role === 'slider')[0];
}

function positionOf(slider) {
  return slider.props.style['--pnn-pos'];
}

test('設定寫入較慢時，膠囊停在目標檔位，不會先回彈', () => {
  const { renderer, slots, writes, timers, hostRefresh } = mount();
  const { overlayRoot, slider } = openPanel(renderer, slots);
  assert.equal(positionOf(slider), '1', '初始應在標準檔');

  const afterClick = clickSegment(renderer, overlayRoot, slider, 0);
  assert.equal(positionOf(afterClick), '0', '點擊後應立即停在目標檔位');
  assert.equal(afterClick.props['aria-valuenow'], 0, '無障礙值應同步為目標檔位');
  assert.equal(writes.length, 1, '應寫入一次設定');
  assert.equal(writes[0].value, 'gentle');

  // 主機還沒回寫：即使有殘留的計時器跑過、再渲染多次，也不能彈回舊檔位。
  timers.splice(0).forEach((callback) => callback());
  const stillPending = renderer.renderTree(overlayRoot);
  const pendingSlider = findAll(stillPending, (node) => node.props?.role === 'slider')[0];
  assert.equal(positionOf(pendingSlider), '0', '主機確認前不得回彈');

  // 主機接受並更新快照：停在目標檔位。
  writes[0].resolve(true);
  hostRefresh('gentle');
  const confirmed = renderer.renderTree(overlayRoot);
  const confirmedSlider = findAll(confirmed, (node) => node.props?.role === 'slider')[0];
  assert.equal(positionOf(confirmedSlider), '0');
});

test('寫入被拒絕時回退到主機檔位', () => {
  const { renderer, slots, writes } = mount();
  const { overlayRoot, slider } = openPanel(renderer, slots);

  const afterClick = clickSegment(renderer, overlayRoot, slider, 2);
  assert.equal(positionOf(afterClick), '2', '點擊後應先停在目標檔位');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, 'chatty');

  writes[0].resolve(false);
  // 等 rejection 的 then 回呼排進微任務。
  return Promise.resolve().then(() => {
    const reverted = renderer.renderTree(overlayRoot);
    const revertedSlider = findAll(reverted, (node) => node.props?.role === 'slider')[0];
    assert.equal(positionOf(revertedSlider), '1', '被拒絕後應回到主機檔位');
  });
});

test('外部改動（非本面板提交）以主機為準', () => {
  const { renderer, slots, hostRefresh } = mount();
  const { overlayRoot, slider } = openPanel(renderer, slots);
  const afterClick = clickSegment(renderer, overlayRoot, slider, 2);
  assert.equal(positionOf(afterClick), '2');

  hostRefresh('gentle');
  const tree = renderer.renderTree(overlayRoot);
  const nextSlider = findAll(tree, (node) => node.props?.role === 'slider')[0];
  assert.equal(positionOf(nextSlider), '0', '主機外部改動應覆蓋樂觀位置');
});
