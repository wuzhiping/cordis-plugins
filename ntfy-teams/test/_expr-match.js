(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(3000);

  // 主輸入框很可能是 contenteditable 的 div（不是 textarea）
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"], [contenteditable=""]'));
  const out = {
    editables: editables.length,
    textareas: document.querySelectorAll('textarea').length,
    inputs: document.querySelectorAll('input').length
  };

  // 列出所有可能的輸入框（含 placeholder 的 div）
  const cand = Array.from(document.querySelectorAll('[contenteditable], textarea, input'));
  out.list = cand.slice(0, 12).map((el) => {
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 60),
      ph: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
      inNtfy: !!el.closest('[class*="ntfy-teams"]'),
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
      radius: cs.borderRadius,
      outline: cs.outlineWidth + ' ' + cs.outlineStyle,
      shadow: cs.boxShadow.slice(0, 70)
    };
  });

  // ★ 關鍵：列出**所有**會套到主輸入框的 CSS 規則，看有沒有一條是 ntfy-teams 的
  const target = cand.find((el) => !el.closest('[class*="ntfy-teams"]'));
  if (target) {
    out.targetInfo = { tag: target.tagName, cls: String(target.className || '').slice(0, 80) };
    const matched = [];
    for (const ss of Array.from(document.styleSheets)) {
      let rules = null;
      try { rules = ss.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      const scan = (rs) => {
        for (const r of Array.from(rs)) {
          if (r.cssRules) { scan(r.cssRules); continue; }
          if (!r.selectorText) continue;
          try {
            if (target.matches(r.selectorText)) {
              matched.push(r.selectorText + '  { ' + String(r.style.cssText).slice(0, 90) + ' }');
            }
          } catch (e) { /* 選擇器不合法就跳過 */ }
        }
      };
      scan(rules);
    }
    out.matchedRules = matched;
    out.matchedIsNtfy = matched.filter((s) => s.indexOf('ntfy-teams') !== -1).length;
  }
  return JSON.stringify(out, null, 1);
})()
