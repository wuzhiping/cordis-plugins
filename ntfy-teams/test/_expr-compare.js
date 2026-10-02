(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 120 && !window.__ntfyTeamsCore; i++) await sleep(500);
  await sleep(2500);

  // 開面板
  let row = null;
  for (let i = 0; i < 70 && !row; i++) {
    const rows = Array.from(document.querySelectorAll('[class*="panelRow"]'));
    row = rows.find((r) => r.textContent.indexOf('團隊協同') !== -1);
    if (!row) await sleep(500);
  }
  if (row) row.click();
  await sleep(3000);

  const report = (label, el) => {
    if (!el) return { label: label, missing: true };
    const cs = getComputedStyle(el);
    return {
      label: label,
      元素: el.tagName + '.' + String(el.className || '').slice(0, 40),
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
      radius: cs.borderRadius,
      boxShadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 60),
      bg: cs.backgroundColor,
      outline: cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor
    };
  };

  const out = {};
  // 主 session 輸入框
  const main = Array.from(document.querySelectorAll('[contenteditable]'))
    .find((e) => (e.getAttribute('placeholder') || '').indexOf('描述') !== -1)
    || document.querySelector('[contenteditable]');
  out['主session輸入框'] = report('主session', main);
  if (main) {
    // 它的「視覺邊框」在哪一層
    let n = main;
    for (let i = 0; i < 8 && n; i += 1) {
      const cs = getComputedStyle(n);
      if (cs.boxShadow !== 'none' || (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none')) {
        out['主session邊框在哪一層'] = {
          層級: i,
          cls: String(n.className || '').slice(0, 50),
          border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
          shadow: cs.boxShadow.slice(0, 70),
          radius: cs.borderRadius
        };
        break;
      }
      n = n.parentElement;
    }
  }
  // 我的輸入框
  out['我的輸入框'] = report('ntfy-teams', document.querySelector('.ntfy-teams-textarea'));

  // 有沒有任何 ntfy-teams 規則套到主輸入框或它的祖先？
  const ntfyEls = Array.from(document.querySelectorAll('[class*="ntfy-teams"]'));
  out['頁面上ntfy-teams元素數'] = ntfyEls.length;
  out['面板是否包含主輸入框'] = main ? !!main.closest('[class*="ntfy-teams"]') : null;

  return JSON.stringify(out, null, 1);
})()
