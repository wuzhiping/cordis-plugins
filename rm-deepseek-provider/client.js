// Browser entry for the rm-deepseek-provider bundle.
//
// The Plugins page (the Plugin Manager) offers exactly two ways to install a
// third-party plugin, and they are the same path twice:
//
//   1. the "Add plugin" primary button (添加插件 / Add plugin), and
//   2. the adjacent dropdown, whose first entry is "Install a third-party
//      plugin" (安装第三方插件 / Install a third-party plugin).
//
// Both open the same install dialog, so hiding the whole add-plugin group
// removes every third-party install path the page offers. Installed bundles
// keep their own switches and uninstall actions.
//
// Two independent selectors mark that group, so one upstream markup change
// cannot silently disable the hiding:
//
//   1. `[data-plugin-panel] span[role="group"][aria-label]`
//      Plain attributes only. `[data-plugin-panel]` is the Plugins page root;
//      the group is the page's only `span[role="group"][aria-label]`. The
//      page's other `role="group"` is the install-approval <section>, which
//      uses aria-labelledby and therefore does not match. This selector
//      survived DSH 0.2.1-rc.2 → rc.5 unchanged.
//
//   2. `[data-plugin-panel] [class*="addGroup"]`
//      The group's CSS-module class keeps the readable suffix `addGroup`
//      across builds even though the hash prefix changes. This one still
//      matches when the attributes above are renamed.
//
// Neither selector matches on text, so the hiding holds for every UI language.
//
// Two layers, like the sibling sidebar plugin: a stylesheet rule (survives
// React re-renders) plus an inline `display:none` mark reapplied by a
// MutationObserver (covers a group already mounted when this plugin starts).
//
// Diagnostics are published as a keyed slot occupant whose key the page never
// dispatches, so nothing renders; a Host-side `cordis_inspect_query` against
// the client Slots provider reads the last state.

window.__ModuleLoader__.load({
  id: '@local/rm-deepseek-provider',
  factory: function (require) {
    var GROUP_SELECTORS = [
      '[data-plugin-panel] span[role="group"][aria-label]',
      '[data-plugin-panel] [class*="addGroup"]'
    ];
    var PANEL_SELECTOR = '[data-plugin-panel]';
    var DIAG_SLOT = 'plugins.row.config';
    var DIAG_PREFIX = 'rmdp-diag:';
    var HIDDEN_ATTR = 'data-rmdp-hidden';

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.effect(function () {
          var style = document.createElement('style');
          style.setAttribute('data-rm-deepseek-provider', 'hide-install');
          style.textContent = GROUP_SELECTORS.join(',') + '{display:none !important;}';
          document.head.appendChild(style);

          var diagDispose = null;
          var lastDiag = null;

          /** Publish the last observation as a slot occupant that renders nothing. */
          function publishDiag(text) {
            if (text === lastDiag) return;
            lastDiag = text;
            if (diagDispose !== null) {
              try { diagDispose(); } catch (e) {}
              diagDispose = null;
            }
            try {
              diagDispose = ctx.slots.inject(DIAG_SLOT, function () {
                return ctx.slots.register({ name: DIAG_SLOT, key: DIAG_PREFIX + text }, function () {
                  return null;
                });
              });
            } catch (e) {}
          }

          function toArray(selector) {
            try {
              return Array.prototype.slice.call(document.querySelectorAll(selector));
            } catch (e) {
              return [];
            }
          }

          /** Every add-plugin group any selector currently matches, without duplicates. */
          function groups() {
            var found = [];
            for (var s = 0; s < GROUP_SELECTORS.length; s += 1) {
              var hits = toArray(GROUP_SELECTORS[s]);
              for (var i = 0; i < hits.length; i += 1) {
                if (found.indexOf(hits[i]) === -1) found.push(hits[i]);
              }
            }
            return found;
          }

          /** Hide every add-plugin group currently mounted and report what was found. */
          function pass() {
            var nodes = groups();
            for (var i = 0; i < nodes.length; i += 1) {
              nodes[i].style.display = 'none';
              nodes[i].setAttribute(HIDDEN_ATTR, '1');
            }
            var panels = toArray(PANEL_SELECTOR).length;
            var display = '-';
            if (nodes.length > 0) {
              try { display = window.getComputedStyle(nodes[0]).display; } catch (e) {}
            }
            var perSelector = GROUP_SELECTORS.map(function (selector) {
              return toArray(selector).length;
            }).join('/');
            publishDiag('panel=' + panels + ' group=' + nodes.length + ' sel=' + perSelector + ' disp=' + display);
          }

          pass();

          var scheduled = null;

          function schedule() {
            if (scheduled !== null) return;
            scheduled = window.setTimeout(function () {
              scheduled = null;
              pass();
            }, 200);
          }

          // childList only: the observer watches for newly mounted groups, not for
          // our own style/attribute writes, so it cannot feed itself.
          var observer = null;
          if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(schedule);
            observer.observe(document.body, { childList: true, subtree: true });
          }

          return function () {
            if (scheduled !== null) {
              window.clearTimeout(scheduled);
              scheduled = null;
            }
            if (observer !== null) {
              observer.disconnect();
              observer = null;
            }
            var nodes = groups();
            for (var k = 0; k < nodes.length; k += 1) {
              nodes[k].style.display = '';
              nodes[k].removeAttribute(HIDDEN_ATTR);
            }
            if (style.parentNode !== null) style.parentNode.removeChild(style);
            if (diagDispose !== null) {
              try { diagDispose(); } catch (e) {}
              diagDispose = null;
            }
            lastDiag = null;
          };
        }, 'rm-deepseek-provider: hide the Plugins page add-plugin controls');
      }
    };
  }
});
