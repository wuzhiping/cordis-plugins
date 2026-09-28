// Dependency-free smoke test for the jeeflow-panel client bundle.
//
// lib/client.js is a browser bundle: it registers its factory with
// `window.__ModuleLoader__.load` and only touches `document`/`window` inside
// functions. This test stands in for the three host-provided things it needs
// and checks the contract the DSH Web GUI actually depends on:
//
//   * the module registers under the bundle id and injects ["slots","locale"];
//   * apply() contributes exactly ONE `conversation.view` entry, with the id,
//     order (after chat=0 and trajectory=10), locale namespace and label the
//     tab strip reads;
//   * the rendered view carries the toolbar, the iframe host div and the
//     loading overlay;
//   * the iframe singleton is created once, points at the configured URL, and
//     is parked offscreen rather than destroyed on unmount;
//   * the stylesheet installs once and is removed by its disposer.
//
// Run: node test/smoke.js   (or: npm test)
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

// --- stand-ins -------------------------------------------------------------

/** A recorded `window.__ModuleLoader__.load({id, factory})` call. */
const bundleSpecs = [];
global.window = {
  __ModuleLoader__: {
    load(spec) {
      bundleSpecs.push(spec);
    },
  },
  open() {},
};

/** Minimal React: createElement + the three hooks the view uses. */
const reactHooks = { effects: [] };
const fakeReact = {
  createElement(type, props) {
    return {
      type,
      props: props === null || props === undefined ? {} : props,
      children: Array.prototype.slice.call(arguments, 2),
    };
  },
  useRef(initial) {
    return { current: initial === undefined ? null : initial };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, function () {}];
  },
  useEffect(effect) {
    reactHooks.effects.push(effect);
  },
};

const fakeRequire = (specifier) => {
  if (specifier === "react") return fakeReact;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
};

/** A DOM stub that is just real enough for createElement/appendChild. */
function fakeElement(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    attrs: {},
    children: [],
    parentNode: null,
    style: { cssText: "" },
    id: "",
    className: "",
    textContent: "",
    listeners: {},
    setAttribute(key, value) {
      this.attrs[key] = value;
      if (key === "id") this.id = value;
    },
    getAttribute(key) {
      return this.attrs[key];
    },
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.listeners[type] || [];
      const at = list.indexOf(handler);
      if (at !== -1) list.splice(at, 1);
    },
    appendChild(child) {
      if (child.parentNode !== null) child.parentNode.removeChild(child);
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at !== -1) this.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
  };
}

const documentStub = {
  head: fakeElement("head"),
  body: fakeElement("body"),
  createElement: fakeElement,
  getElementById(id) {
    const found = documentStub.head.children.find((node) => node.id === id);
    return found === undefined ? null : found;
  },
};

// --- load the bundle -------------------------------------------------------

const BUNDLE = path.join(__dirname, "..", "lib", "client.js");
const plugin = require(BUNDLE);

assert.equal(bundleSpecs.length, 1, "the bundle registers exactly one module");
const spec = bundleSpecs[0];
assert.equal(spec.id, "jeeflow-panel", "module id matches the bundle name");
assert.equal(typeof spec.factory, "function", "the module ships a factory");

const mod = spec.factory(fakeRequire);
assert.equal(typeof mod.apply, "function", "the factory exports apply");
assert.deepEqual(mod.inject, ["slots", "locale"], "it injects slots + locale");

// --- a recording client context -------------------------------------------

const effects = [];
const injections = [];
const registrations = [];
const dictionaries = [];

const ctx = {
  effect(callback, name) {
    const disposer = callback();
    effects.push({ name, disposer });
    return disposer;
  },
  locale: {
    register(namespace, dict) {
      dictionaries.push({ namespace, dict });
      return function unregister() {};
    },
    bind() {
      return (key) => mod.__internals.zh[key];
    },
  },
  slots: {
    inject(name, callback) {
      const disposer = callback();
      injections.push({ name, disposer });
      return disposer;
    },
    register(options, component) {
      const disposer = function disposeRegistration() {};
      registrations.push({ options, component, disposer });
      return disposer;
    },
  },
};

global.document = undefined; // installStyles must survive a document-less host
mod.apply(ctx);
assert.equal(effects.length, 2, "apply registers styles + dictionaries");
assert.equal(
  effects[0].name,
  "jeeflow-panel: styles",
  "the first effect owns the stylesheet"
);
assert.equal(
  effects[1].name,
  "jeeflow-panel: dictionaries",
  "the second effect owns the dictionaries"
);

assert.equal(dictionaries.length, 1, "one namespace is registered");
assert.equal(dictionaries[0].namespace, "jeeflow-panel", "namespace is the bundle name");
assert.ok(dictionaries[0].dict.zh["view.jeeflow"], "a zh dictionary is provided");
assert.ok(dictionaries[0].dict.en["view.jeeflow"], "an en dictionary is provided");

// --- the tab registration --------------------------------------------------

assert.equal(injections.length, 1, "exactly one slot is contributed");
assert.equal(injections[0].name, "conversation.view", "it is a conversation view");
assert.equal(registrations.length, 1, "exactly one view is registered");

const { options, component, disposer } = registrations[0];
assert.equal(options.name, "conversation.view", "registered against conversation.view");
assert.equal(options.id, "jeeflow", "entry id is stable (it is persisted per session)");
assert.equal(typeof options.order, "number", "order is a number");
assert.ok(options.order > 10, "order sorts the tab after 轨迹 (trajectory = 10)");
assert.equal(options.locale, "jeeflow-panel", "the entry declares its locale namespace");
assert.equal(typeof options.label, "function", "label is a lazy resolver");
assert.equal(options.label(), "工作流", "the zh label resolves through the dictionary");
assert.equal(injections[0].disposer, disposer, "the effect owns the registration disposer");

// --- the rendered view -----------------------------------------------------

function findAll(node, predicate, out) {
  const found = out || [];
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

const t = (key) => mod.__internals.zh[key];
const tree = component({ t });

assert.equal(tree.type, "div", "the view root is a div");
assert.equal(tree.props.className, "jfp-root", "the root carries the panel class");

const hosts = findAll(tree, (node) => node.props.className === "jfp-frameHost");
assert.equal(hosts.length, 1, "there is exactly one iframe host");
assert.ok(hosts[0].props.ref, "the host carries the ref the effect re-parents into");

const buttons = findAll(tree, (node) => node.type === "button");
assert.equal(buttons.length, 2, "the toolbar offers reload + open-in-new-tab");
assert.deepEqual(
  buttons.map((b) => b.props.title),
  [t("panel.reload"), t("panel.open")],
  "the toolbar buttons use the localized labels"
);

const overlays = findAll(tree, (node) => node.props.className === "jfp-overlay");
assert.equal(overlays.length, 1, "the loading overlay renders until the frame loads");
assert.ok(
  findAll(tree, (node) => node.children.includes(t("panel.loading"))).length === 1,
  "the overlay names the loading state"
);

// --- the iframe singleton --------------------------------------------------

global.document = documentStub;
mod.__internals.reset();
assert.equal(documentStub.body.children.length, 0, "nothing is appended before first mount");

const frame = mod.__internals.ensureFrame();
assert.equal(frame.tagName, "IFRAME", "the singleton is an iframe");
assert.equal(frame.src, mod.__internals.PANEL_URL, "it points at the configured URL");
assert.equal(frame.attrs.allow.indexOf("fullscreen") !== -1, true, "fullscreen is allowed");
assert.equal(
  mod.__internals.ensureFrame(),
  frame,
  "ensureFrame is idempotent (never a second iframe)"
);
assert.equal(documentStub.body.children.length, 1, "the offscreen keeper is attached to body");

const keeper = documentStub.body.children[0];
assert.equal(keeper.children[0], frame, "the fresh frame starts parked");

// Simulate a mount (re-parent) followed by an unmount (park again).
const host = fakeElement("div");
host.appendChild(frame);
assert.equal(frame.parentNode, host, "mounting re-parents the live frame");
mod.__internals.parkFrame();
assert.equal(frame.parentNode, keeper, "unmounting parks it instead of destroying it");
assert.equal(keeper.children[0], frame, "the parked frame is still the same node");

// --- the stylesheet --------------------------------------------------------

const styleDisposer = mod.__internals.installStyles();
assert.equal(documentStub.head.children.length, 1, "the stylesheet installs once");
assert.ok(
  documentStub.head.children[0].textContent.indexOf(".jfp-frameWrap") !== -1,
  "the stylesheet carries the panel rules"
);
mod.__internals.installStyles();
assert.equal(documentStub.head.children.length, 1, "re-installing is a no-op");
styleDisposer();
assert.equal(documentStub.head.children.length, 0, "the disposer removes the stylesheet");

console.log("jeeflow-panel: smoke test passed");
