// Browser entry for the rm-deepseek-provider bundle.
//
// Two independent jobs in the browser:
//
// 1. Plugins page (Plugin Manager): hide the add-plugin controls, so no
//    third-party plugin can be installed from the GUI.
//
//    The page offers exactly two ways to install a third-party plugin, and
//    they are the same path twice: the "Add plugin" primary button
//    (添加插件 / Add plugin) and the adjacent dropdown, whose first entry is
//    "Install a third-party plugin" (安装第三方插件 / Install a third-party
//    plugin). Both open the same install dialog, so hiding the whole
//    add-plugin group removes every third-party install path the page offers.
//    Installed bundles keep their own switches and uninstall actions.
//
//    Two independent selectors mark that group, so one upstream markup change
//    cannot silently disable the hiding:
//
//      a. `[data-plugin-panel] span[role="group"][aria-label]`
//         Plain attributes only. `[data-plugin-panel]` is the Plugins page
//         root; the group is the page's only
//         `span[role="group"][aria-label]`. The page's other `role="group"`
//         is the install-approval <section>, which uses aria-labelledby and
//         therefore does not match. This selector survived DSH 0.2.1-rc.2 →
//         rc.5 unchanged.
//
//      b. `[data-plugin-panel] [class*="addGroup"]`
//         The group's CSS-module class keeps the readable suffix `addGroup`
//         across builds even though the hash prefix changes.
//
//    Neither selector matches on text, so the hiding holds for every UI
//    language.
//
// 2. The three region-local More menus (left sidebar, Conversation View tabs,
//    right sidebar): drop the "Browse other plugins" row.
//
//    DSH 0.2.1-rc.5 ships `@deepseek-ai/dsh-client-ui-entry-customization`,
//    which registers one component into all three regions' action slots under
//    the cell id `entry-customization`. That component renders the folded
//    Conversation Views (conversation region only) and then two rows:
//    "Browse other plugins" and "Create your plugin".
//
//    This plugin registers its own component into the same cell id, which the
//    slot contract defines as taking over that cell ("reusing a shipped id
//    puts you in THAT cell and replaces it"). The replacement renders the
//    folded Conversation Views and the "Create your plugin" row, and nothing
//    else — so the browse row is gone everywhere while the folded views stay
//    reachable and the Creator still works.
//
// Both jobs use two layers, like the sibling sidebar plugin: a stylesheet rule
// (survives React re-renders) plus an inline `display:none` mark reapplied by
// a MutationObserver (covers a group that was already mounted when this
// plugin starts).
//
// Diagnostics are published as a keyed slot occupant whose key the page never
// dispatches, so nothing renders; a Host-side `cordis_inspect_query` against
// the client Slots provider reads the last state.

window.__ModuleLoader__.load({
  id: '@local/rm-deepseek-provider',
  factory: function (require) {
    var React = null;
    var primitives = null;
    try {
      React = require('react');
    } catch (e) {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (e) {}

    var GROUP_SELECTORS = [
      '[data-plugin-panel] span[role="group"][aria-label]',
      '[data-plugin-panel] [class*="addGroup"]'
    ];
    var PANEL_SELECTOR = '[data-plugin-panel]';
    var DIAG_SLOT = 'plugins.row.config';
    var DIAG_PREFIX = 'rmdp-diag:';
    var HIDDEN_ATTR = 'data-rmdp-hidden';

    // The cell this plugin owns in the three region-local More menus. The
    // shipped entry-customization component is disabled by the bundle patch
    // (a list slot refuses a second entry with the same id), so this id is
    // free.
    var CELL_ID = 'rm-deepseek-provider';
    var LOCALE_NS = 'rmDeepseekProvider';
    var MORE_SLOTS = [
      { name: 'sidebar.panellist.actions', region: 'sidebar' },
      { name: 'conversation.session.header.views.actions', region: 'conversation' },
      { name: 'sidebar.right.tab.guide.actions', region: 'rightbar' }
    ];
    var LOCALE = {
      en: {
        create: 'Create your plugin',
        'createPrompt.sidebar': 'Create a DSH plugin with a left sidebar entry.',
        'createPrompt.conversation': 'Create a DSH conversation view plugin.',
        'createPrompt.rightbar': 'Create a DSH plugin with a right sidebar entry.'
      },
      zh: {
        create: '创建你的插件',
        'createPrompt.sidebar': '创建一个带左侧栏入口的 DSH 插件。',
        'createPrompt.conversation': '创建一个 DSH 会话视图插件。',
        'createPrompt.rightbar': '创建一个带右侧栏入口的 DSH 插件。'
      }
    };
    var EXTRA_CSS =
      '.rmdp-entryName{align-items:center;gap:8px;display:flex}' +
      '.rmdp-entryTitle{overflow-wrap:anywhere;white-space:normal;min-width:0}' +
      '.rmdp-activeMark{flex:none;margin-left:auto}';

    /**
     * The More-menu rows this plugin keeps: the folded Conversation Views (the
     * conversation region only) and the "Create your plugin" row. The shipped
     * component's "Browse other plugins" row is deliberately absent.
     */
    function MoreMenuRows(props) {
      if (React === null || primitives === null) return null;
      var h = React.createElement;
      var t = props.t;
      var region = props.region;
      var entries = region === 'conversation' && props.entries !== undefined && props.entries !== null ? props.entries : [];
      var children = entries.map(function (entry) {
        return h(primitives.MenuItemButton, {
          key: entry.id,
          current: entry.active === true,
          onSelect: function () {
            props.onDismiss();
            props.onOpen(entry.id);
          },
          children: h('span', { className: 'rmdp-entryName' },
            h('span', { className: 'rmdp-entryTitle', children: entry.label }),
            entry.active === true
              ? h(primitives.IconCheckOutlineRegular, { size: 16, className: 'rmdp-activeMark' })
              : null)
        });
      });
      children.push(h(primitives.MenuItemButton, {
        key: 'rmdp-create',
        icon: h(primitives.IconPlusOutlineRegular, { size: 16 }),
        onSelect: function () {
          props.onDismiss();
          props.createPlugin();
        },
        children: t('create')
      }));
      return h(React.Fragment, null, children);
    }

    return {
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        ctx.effect(function () {
          var style = document.createElement('style');
          style.setAttribute('data-rm-deepseek-provider', 'hide-install');
          style.textContent = GROUP_SELECTORS.join(',') + '{display:none !important;}' + EXTRA_CSS;
          document.head.appendChild(style);

          var diagDispose = null;
          var lastDiag = null;
          var menuState = 'off';

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

          /** How many of each More menu's cell winners are this plugin's own rows. */
          function slotState() {
            var parts = [];
            for (var i = 0; i < MORE_SLOTS.length; i += 1) {
              var slot = MORE_SLOTS[i];
              var winners = [];
              try {
                winners = ctx.slots.entriesOfSlot(slot.name);
              } catch (e) {}
              var ours = 0;
              var ids = [];
              for (var w = 0; w < winners.length; w += 1) {
                var options = winners[w].options;
                var id = options !== undefined && options !== null ? options.id : '?';
                ids.push(String(id));
                if (id === CELL_ID) ours += 1;
              }
              parts.push(slot.region + ':' + String(winners.length) + '/' + String(ours) + '[' + ids.join(',') + ']');
            }
            return parts.join(' ');
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
            publishDiag(
              'panel=' + panels + ' group=' + nodes.length + ' sel=' + perSelector +
              ' disp=' + display + ' menu=' + menuState + ' slots=' + slotState()
            );
          }

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

          // Take over the shipped "Browse other plugins" cell of every
          // region-local More menu. Its own effect, and guarded: a failure here
          // must not take the Plugins-page hiding down with it.
          var menuDisposable = null;
          if (primitives === null || React === null) {
            menuState = 'no-primitives';
          } else {
            try {
              ctx.effect(function () {
                return ctx.locale.register(LOCALE_NS, LOCALE);
              });
              var t = ctx.locale.bind(LOCALE_NS);
              var disposers = [];
              MORE_SLOTS.forEach(function (slot) {
                disposers.push(ctx.slots.inject(slot.name, function () {
                  return ctx.slots.register({
                    name: slot.name,
                    id: CELL_ID,
                    locale: LOCALE_NS,
                    inject: function () {
                      return {
                        region: slot.region,
                        createPlugin: function () {
                          var workspace = ctx.get('uiWorkspace');
                          if (workspace === undefined) return;
                          workspace.startSession(undefined, {
                            agentPreset: 'cordis',
                            prompt: t('createPrompt.' + slot.region),
                            whenDraftExists: 'append'
                          });
                        }
                      };
                    }
                  }, MoreMenuRows);
                }));
              });
              menuDisposable = function () {
                for (var i = 0; i < disposers.length; i += 1) {
                  try { disposers[i](); } catch (e) {}
                }
              };
              menuState = 'on';
            } catch (e) {
              menuState = 'error:' + String(e && e.message ? e.message : e).slice(0, 120);
            }
          }

          pass();

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
            if (menuDisposable !== null) {
              menuDisposable();
              menuDisposable = null;
            }
            if (diagDispose !== null) {
              try { diagDispose(); } catch (e) {}
              diagDispose = null;
            }
            lastDiag = null;
          };
        }, 'rm-deepseek-provider: hide the Plugins page add-plugin controls and the More menus\' browse rows');
      }
    };
  }
});
