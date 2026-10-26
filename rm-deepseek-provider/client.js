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
// The selector uses plain attributes only — never a hashed CSS-module class —
// so an upstream rebuild of the Plugins page cannot silently miss it:
//
//   [data-plugin-panel]             the Plugins page root (`data-plugin-panel`)
//   span[role="group"][aria-label]  the add-plugin group; the page's only
//                                    other `role="group"` is the
//                                    install-approval <section>, which uses
//                                    aria-labelledby and therefore does not
//                                    match.
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
    var GROUP_SELECTOR = '[data-plugin-panel] span[role="group"][aria-label]';
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
          style.textContent = GROUP_SELECTOR + '{display:none !important;}';
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

          /** Hide every add-plugin group currently mounted and report what was found. */
          function pass() {
            var groups = toArray(GROUP_SELECTOR);
            for (var i = 0; i < groups.length; i += 1) {
              groups[i].style.display = 'none';
              groups[i].setAttribute(HIDDEN_ATTR, '1');
            }
            var panels = toArray(PANEL_SELECTOR).length;
            var display = '-';
            if (groups.length > 0) {
              try { display = window.getComputedStyle(groups[0]).display; } catch (e) {}
            }
            publishDiag('panel=' + panels + ' group=' + groups.length + ' disp=' + display);
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
            var groups = toArray(GROUP_SELECTOR);
            for (var k = 0; k < groups.length; k += 1) {
              groups[k].style.display = '';
              groups[k].removeAttribute(HIDDEN_ATTR);
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
