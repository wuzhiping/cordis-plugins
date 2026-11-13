/**
 * 過程播報介面多語測試：用假 locale 服務載入 client.js，
 * 驗證四份字典都有註冊、鍵集合一致，以及各語言下入口與面板的文案。
 *
 * 執行：node --test（在插件目錄）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const NS = 'dsh-progress-narration';

function findElement(node, matches) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'function') return findElement(node.type(node.props), matches);
  if (matches(node)) return node;
  for (const child of node.children) {
    const match = findElement(child, matches);
    if (match) return match;
  }
}

/** 以給定語言裝載插件；localeId 為 null 時模擬沒有 locale 服務的退化環境。 */
function mount(localeId, primitives = { MenuSurface: 'dialog' }) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    createRef: () => ({ current: null }),
    useRef: (current) => ({ current }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    // 立即執行 effect（等同掛載後一次）：讓 locale 訂閱等副作用可被觀察。
    useEffect: (effect) => {
      effect();
    },
  };
  const modules = {
    react,
    'react-dom': { createPortal: (node) => node },
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  };
  const slots = new Map();
  const registered = [];
  let localeListener = null;
  let localeSubscriptions = 0;
  const locale = localeId === null ? undefined : {
    getSnapshot: () => ({ active: localeId, locales: [], revision: 1 }),
    subscribe: (listener) => {
      localeSubscriptions += 1;
      localeListener = listener;
      return () => {
        localeListener = null;
      };
    },
    register: (ns, id, dict) => {
      registered.push({ ns, id, dict });
      return () => {};
    },
    bind: () => (key) => key,
  };
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { mode: 'balanced' } }),
    set: () => {},
    subscribe: () => () => {},
  };
  const load = ({ factory }) => factory((name) => modules[name]).apply({
    locale,
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
    console,
  });
  return { slots, registered, listener: () => localeListener, subscriptions: () => localeSubscriptions };
}

test('四種語言都有字典，且鍵集合一致', () => {
  const { registered } = mount('zh');
  const dicts = registered.filter((entry) => entry.ns === NS);
  assert.equal(registered.length, 4, '四份語言表都應註冊一次');
  assert.deepEqual(dicts.map((entry) => entry.id).sort(), ['en', 'vi-vn', 'zh', 'zh-tw']);
  const keySets = dicts.map((entry) => Object.keys(entry.dict).sort().join(','));
  assert.equal(new Set(keySets).size, 1, '四份字典的鍵集合必須一致');
  assert.equal(keySets[0].split(',').length, 10);
});

test('入口按語言顯示，並在語言切換時訂閱刷新', () => {
  const cases = [
    ['zh', '过程播报：标准'],
    ['en', 'Progress narration: Balanced'],
    ['zh-TW', '過程播報：標準'],
    ['vi-VN', 'Tường thuật tiến trình: Tiêu chuẩn'],
    ['zh-Hant', '過程播報：標準'],
    ['ja', 'Progress narration: Balanced'],
  ];
  for (const [localeId, expected] of cases) {
    const { slots, listener, subscriptions } = mount(localeId);
    const trigger = findElement(slots.get('conversation.input.right')(), (node) => node.type === 'button');
    assert.equal(trigger.props['aria-label'], expected, `${localeId} 入口無障礙名稱不符`);
    assert.equal(trigger.props.title, expected, `${localeId} 入口 title 不符`);
    assert.equal(subscriptions(), 1, '應訂閱一次 locale 變更');
    assert.equal(typeof listener(), 'function', '訂閱回呼應可用於 force update');
  }
});

test('面板與分段控件的文案同樣本地化', () => {
  const { slots } = mount('vi-VN');
  const trigger = findElement(slots.get('conversation.input.right')(), (node) => node.type === 'button');
  trigger.props.onClick();
  const overlay = slots.get('shell.overlay')();

  const dialog = findElement(overlay, (node) => node.props?.role === 'dialog');
  assert.equal(dialog.props['aria-label'], 'Tường thuật tiến trình');

  const slider = findElement(overlay, (node) => node.props?.role === 'slider');
  assert.equal(slider.props['aria-label'], 'Mật độ phát biểu');
  assert.equal(slider.props['aria-valuetext'], 'Tiêu chuẩn');
  const reset = findElement(overlay, (node) => node.type === 'button' && node.props?.className === 'pnn-reset');
  assert.equal(reset.props.title, 'Đặt lại mặc định');
  assert.equal(reset.props.disabled, true, '標準档下重置應停用');
});

test('沒有 locale 服務時不崩，回落到英文文案', () => {
  const { slots } = mount(null);
  const trigger = findElement(slots.get('conversation.input.right')(), (node) => node.type === 'button');
  assert.equal(trigger.props['aria-label'], 'Progress narration: Balanced');
});

test('primitives 缺少 MenuSurface 時仍註冊入口，面板退回普通容器（rc.2 回歸）', () => {
  const { slots } = mount('zh', {});
  const trigger = findElement(slots.get('conversation.input.right')(), (node) => node.type === 'button');
  assert.ok(trigger, '入口必須存在');
  assert.equal(trigger.props['aria-label'], '过程播报：标准');

  trigger.props.onClick();
  const overlay = slots.get('shell.overlay')();
  const panel = findElement(overlay, (node) => node.props?.role === 'dialog');
  assert.ok(panel, '面板仍應渲染');
  assert.equal(panel.type, 'div', '缺少 MenuSurface 時退回 div');
});
