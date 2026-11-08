window.__ModuleLoader__.load({
  id: 'dsh-plugin-progress-narration',
  factory(require) {
    /** 可选依赖：缺任何一个都只让插件退化，绝不让整个页面 boot 失败。 */
    const optional = (name) => {
      try {
        return require(name);
      } catch (error) {
        return null;
      }
    };

    const React = optional('react');
    if (React === null) {
      return { inject: [], apply() {} };
    }
    const ReactDOM = optional('react-dom');
    const primitives = optional('@deepseek-ai/dsh-client-ui-primitives') ?? {};
    /** 菜单外壳与锚定都来自 primitives；缺失时保持惰性，不做半残的降级 UI。 */
    if (typeof primitives.MenuSurface === 'undefined' || typeof primitives.useAnchoredPosition !== 'function') {
      return { inject: [], apply() {} };
    }
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** 宿主插件条目 id 的候选写法，取第一个就绪的。 */
    const ENTRY_IDS = ['progress-narration', 'include:progress-narration'];

    /* ── 多語系 ──
     * 字典由插件自己解析，不依賴 locale.lookup：繁中語言包（zhtw）只轉換它認得
     * 的字典內容、且 zh-TW 沒有註冊進 Harness 的 locale catalog，走 fallback 鏈
     * 會直接落到英文；越南文由自己的語言包提供相容層。這裡以快照 active 為準，
     * 明確決定用哪份語言表，行為與其他插件無關。
     */
    const NS = 'dsh-progress-narration';

    const DICTS = {
      zh: {
        'mode.gentle': '克制',
        'mode.balanced': '标准',
        'mode.chatty': '话多',
        'caption.gentle': '只在动手前和关键转折说一句',
        'caption.balanced': '每两三步同步一次进度',
        'caption.chatty': '每完成一步就说一句',
        panel: '过程播报',
        trigger: '过程播报：{mode}',
        reset: '重置为默认',
        density: '说话密度',
      },
      en: {
        'mode.gentle': 'Gentle',
        'mode.balanced': 'Balanced',
        'mode.chatty': 'Chatty',
        'caption.gentle': 'One line before starting and at key turns',
        'caption.balanced': 'Progress every two or three steps',
        'caption.chatty': 'A line after every completed step',
        panel: 'Progress narration',
        trigger: 'Progress narration: {mode}',
        reset: 'Reset to default',
        density: 'Speaking density',
      },
      'zh-tw': {
        'mode.gentle': '克制',
        'mode.balanced': '標準',
        'mode.chatty': '話多',
        'caption.gentle': '只在動手前和關鍵轉折說一句',
        'caption.balanced': '每兩三步同步一次進度',
        'caption.chatty': '每完成一步就說一句',
        panel: '過程播報',
        trigger: '過程播報：{mode}',
        reset: '重設為預設',
        density: '說話密度',
      },
      'vi-vn': {
        'mode.gentle': 'Tiết chế',
        'mode.balanced': 'Tiêu chuẩn',
        'mode.chatty': 'Nói nhiều',
        'caption.gentle': 'Một câu trước khi bắt tay và ở các bước ngoặt chính',
        'caption.balanced': 'Cập nhật tiến độ mỗi hai hoặc ba bước',
        'caption.chatty': 'Một câu sau mỗi bước hoàn thành',
        panel: 'Tường thuật tiến trình',
        trigger: 'Tường thuật tiến trình: {mode}',
        reset: 'Đặt lại mặc định',
        density: 'Mật độ phát biểu',
      },
    };

    /** 三档密度的稳定身份；文字在渲染时按语言取。 */
    const MODE_DEFS = [
      { id: 'gentle', face: 'quiet' },
      { id: 'balanced', face: 'calm' },
      { id: 'chatty', face: 'talk' },
    ];

    /** apply 里注入的 locale 服务；测试或退化环境为 null，回落到英文/简体。 */
    let localeFace = null;

    /** 当前生效语言（小写）；locale 服务缺失时按英文处理。 */
    function activeLanguage() {
      let active;
      try {
        active = localeFace?.getSnapshot?.().active;
      } catch {
        active = undefined;
      }
      return typeof active === 'string' && active.length > 0 ? active.toLowerCase() : 'en';
    }

    /** 语言 → 字典：精确命中优先，其次语言族，最后英文。 */
    function dictFor(active) {
      if (DICTS[active] !== undefined) return DICTS[active];
      if (active.startsWith('zh')) return DICTS['zh-tw'] ?? DICTS.zh;
      if (active.startsWith('vi')) return DICTS['vi-vn'] ?? DICTS.en;
      return DICTS.en;
    }

    /** 取一条界面文案；缺键时回落到简体原文，再回落到键名。 */
    function text(key, params) {
      const dict = dictFor(activeLanguage());
      let template = dict[key] ?? DICTS.zh[key] ?? key;
      if (params !== undefined && params !== null) {
        template = template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      }
      return template;
    }

    /** 三档的本地化文案，按渲染时的语言实时取值。 */
    function modes() {
      return MODE_DEFS.map((def) => ({
        ...def,
        label: text(`mode.${def.id}`),
        caption: text(`caption.${def.id}`),
      }));
    }

    /** 语言切换时重建：locale 订阅一次即可，切换后 force update。 */
    function useLocale() {
      const [, force] = useState(0);
      useEffect(() => {
        if (localeFace === null || typeof localeFace.subscribe !== 'function') return undefined;
        return localeFace.subscribe(() => force((value) => value + 1));
      }, []);
    }

    function normalizeMode(value) {
      if (typeof value !== 'string') return 'balanced';
      const key = value.trim();
      const aliases = { 克制: 'gentle', 标准: 'balanced', 话多: 'chatty' };
      const id = aliases[key] ?? key.toLowerCase();
      return MODE_DEFS.some((mode) => mode.id === id) ? id : 'balanced';
    }

    const CSS = `
      .pnn-trigger {
        width: 28px; height: 28px; border: 0; padding: 6px;
        border-radius: var(--dsw-radius-sm, 6px);
        display: inline-flex; align-items: center; justify-content: center;
        background: transparent; color: var(--dsw-alias-label-secondary, #6b6b6b);
        cursor: pointer; line-height: 1; transition: background .12s, color .12s;
      }
      .pnn-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); color: var(--dsw-alias-label-primary, #111); }
      .pnn-trigger:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3F77D8));
        outline-offset: 1px;
      }
      .pnn-menu {
        box-sizing: border-box; position: fixed; z-index: 1100; padding: 0;
        display: flex; flex-direction: column; width: max-content;
        --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
        box-shadow: var(--dsw-elevation-prominent);
        color: var(--dsw-alias-label-primary);
      }
      .pnn-panel {
        display: flex; flex-direction: column; gap: 10px; padding: 16px 12px 14px;
        width: 280px; box-sizing: border-box; animation: pnn-in .16s ease-out;
        background: var(--dsw-alias-bg-layer-2, #fff); border-radius: var(--dsw-radius-lg, 16px);
      }
      @keyframes pnn-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
      .pnn-seg {
        --pnn-pill-fill: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 87%, var(--dsw-alias-label-primary, #111));
        --pnn-pill-text: var(--dsw-alias-label-primary-foreground, #fff);
        --pnn-pill-motion: transform .26s cubic-bezier(.3, 1.05, .5, 1);
        position: relative; display: flex; align-items: stretch;
        height: 34px; padding: 3px; box-sizing: border-box;
        border-radius: 999px; corner-shape: round;
        /* 与官方输入框「+」按钮同一灰：--dsw-specific-selector */
        background: var(--dsw-specific-selector, rgba(38, 49, 72, .10));
        cursor: pointer; outline: none; touch-action: none;
        -webkit-user-select: none; user-select: none;
      }
      .pnn-seg:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3F77D8));
        outline-offset: 3px;
      }
      .pnn-seg.pnn-dragging { cursor: grabbing; }
      .pnn-segments { position: relative; display: flex; width: 100%; }
      .pnn-segLabel {
        flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center;
        font-size: 12px; line-height: 1; font-weight: 500;
        color: var(--dsw-alias-label-secondary, #61666b);
        white-space: nowrap; pointer-events: none;
      }
      .pnn-segPill {
        position: absolute; inset: 0 auto 0 0;
        width: calc(100% / var(--pnn-segments));
        border-radius: 999px; corner-shape: round; overflow: hidden;
        background: var(--pnn-pill-fill);
        box-shadow: 0 1px 2px rgba(0, 0, 0, .10);
        transform: translateX(calc(var(--pnn-pos) * 100%));
        transition: var(--pnn-pill-motion);
      }
      .pnn-seg.pnn-dragging { --pnn-pill-motion: none; }
      .pnn-segPillText {
        position: absolute; top: 0; left: 0; width: calc(100% * var(--pnn-segments)); height: 100%;
        display: flex; align-items: stretch; z-index: 1;
        transform: translateX(calc(var(--pnn-pos) * -100% / var(--pnn-segments)));
        transition: var(--pnn-pill-motion);
      }
      .pnn-segPillText .pnn-segLabel { color: var(--pnn-pill-text); font-weight: 600; }
      .pnn-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 0; min-height: 20px;
      }
      .pnn-headMain {
        display: flex; align-items: center; gap: 7px; min-width: 0;
        animation: pnn-caption-in .18s ease-out;
      }
      .pnn-headIcon {
        flex: none; display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 18px;
        color: var(--dsw-alias-state-business-primary, #3F77D8);
      }
      .pnn-caption {
        margin: 0; min-height: 18px;
        font-size: 12px; line-height: 18px; text-align: left;
        color: var(--dsw-alias-label-secondary, #6b6b6b);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      @keyframes pnn-caption-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
      .pnn-reset {
        flex: none; display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px;
        background: transparent; color: var(--dsw-alias-label-secondary, #6b6b6b);
        cursor: pointer; transition: background .12s ease, color .12s ease, opacity .12s ease;
      }
      .pnn-reset:enabled:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); color: var(--dsw-alias-label-primary, #111); }
      .pnn-reset:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3F77D8));
        outline-offset: 1px;
      }
      .pnn-reset:disabled { opacity: .38; cursor: default; }

      @media (prefers-reduced-motion: reduce) {
        .pnn-panel, .pnn-headMain { animation: none; }
        .pnn-seg { --pnn-pill-motion: none; }
        .pnn-reset { transition: none; }
      }
    `;

    /** 菜单未定位前的测量样式：不可见但参与布局。 */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /* ── 开合状态与锚点，输入框图标和浮层共用 ── */
    let open = false;
    const openListeners = new Set();
    const triggerRef = React.createRef();
    const setOpen = (next) => {
      open = next;
      openListeners.forEach((fn) => fn());
    };
    function useOpen() {
      const [value, setValue] = useState(open);
      useEffect(() => {
        const fn = () => setValue(open);
        openListeners.add(fn);
        return () => openListeners.delete(fn);
      }, []);
      return value;
    }

    /* ── 设置读写：由 apply 里拿到的表单句柄注入 ── */
    let api = null;
    function useConfig() {
      const read = () => (api === null ? null : api.read());
      const [value, setValue] = useState(read);
      useEffect(() => {
        if (api === null) return undefined;
        setValue(read());
        return api.subscribe(() => setValue(read()));
      }, []);
      return value;
    }

    /**
     * 主机设置写入期间保持上一次已确认档位：快照短暂未就绪时不要把界面拉回默认档。
     */
    function useStableMode(config) {
      const lastRef = useRef(null);
      if (config !== null) lastRef.current = config.mode;
      return config === null ? (lastRef.current ?? 'balanced') : config.mode;
    }

    /** 语气图标：描边+点数=克制/标准，实心+射线=话多。 */
    function BubbleIcon({ kind, size = 18 }) {
      const path =
        'M6.6 3.9H13.4A4.2 4.2 0 0 1 17.6 8.1V10A4.2 4.2 0 0 1 13.4 14.2H9.6L7.3 16.3C6.9 16.65 6.3 16.35 6.3 15.85V14.2A4.2 4.2 0 0 1 2.4 10V8.1A4.2 4.2 0 0 1 6.6 3.9Z';
      const filled = kind === 'talk';
      const dots = kind === 'quiet' ? ['10'] : kind === 'calm' ? ['7.9', '12.1'] : ['6.9', '10', '13.1'];
      return h(
        'svg',
        {
          width: String(size),
          height: String(size),
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': 'true',
          style: kind === 'quiet' ? { opacity: 0.55 } : undefined,
        },
        h(
          'path',
          filled
            ? { d: path, fill: 'currentColor' }
            : { d: path, stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linejoin': 'round' },
        ),
        dots.map((cx, index) =>
          h('circle', {
            key: `dot-${index}`,
            cx,
            cy: '9',
            r: filled ? '1.05' : '1.1',
            fill: filled ? '#fff' : 'currentColor',
          }),
        ),
        filled
          ? h('path', {
              d: 'M16.3 3.4l1.2-1.3M17.5 5.7l1.5-.6M14.3 2.1l.5-1.4',
              stroke: 'currentColor',
              'stroke-width': '1.6',
              'stroke-linecap': 'round',
            })
          : null,
      );
    }

    /**
     * 三档密度分段控件。
     * 拖动时只移动胶囊的视觉位置（不写入设置）；松手后吸附到最近一档，
     * 档位有变化才保存一次；取消拖动回到原档，不保存。点击与方向键仍然可用。
     */
    function DensitySlider({ index, pending, disabled, onCommit, onCancel, trackRef, modes: localizedModes }) {
      const segmentsRef = useRef(null);
      const dragRef = useRef(null);
      const [preview, setPreview] = useState(null);
      const last = localizedModes.length - 1;
      const clamp = (value) => Math.min(Math.max(value, 0), last);
      /** 待宿主确认的档位优先于已确认档位：写入期间保持新位置，不做超时回弹。 */
      const position = preview ?? pending ?? index;
      const announced = preview !== null ? clamp(Math.round(preview)) : (pending ?? index);

      const finishDrag = (pointerId) => {
        dragRef.current = null;
        const track = trackRef.current;
        if (track?.hasPointerCapture(pointerId)) track.releasePointerCapture(pointerId);
        setPreview(null);
      };

      const onKeyDown = (event) => {
        const active = dragRef.current;
        if (event.key === 'Escape' && active !== null) {
          event.preventDefault();
          event.stopPropagation();
          finishDrag(active.pointerId);
          return;
        }
        if (disabled) return;
        let target;
        switch (event.key) {
          case 'ArrowLeft':
          case 'ArrowDown': target = clamp(index - 1); break;
          case 'ArrowRight':
          case 'ArrowUp': target = clamp(index + 1); break;
          case 'Home': target = 0; break;
          case 'End': target = last; break;
          default: return;
        }
        event.preventDefault();
        if (active === null) {
          if (target !== index) onCommit(target);
          else if (pending !== null) onCancel();
        }
      };

      const startDrag = (event) => {
        if (disabled || event.button !== 0 || dragRef.current !== null) return;
        const track = event.currentTarget;
        event.preventDefault();
        track.focus({ preventScroll: true });
        track.setPointerCapture(event.pointerId);
        dragRef.current = {
          startX: event.clientX,
          startPos: position,
          moved: false,
          pointerId: event.pointerId,
        };
        setPreview(position);
      };

      const isDragMovement = (dx) => Math.abs(dx) > 3;

      const moveDrag = (event) => {
        const active = dragRef.current;
        if (active?.pointerId !== event.pointerId) return;
        const dx = event.clientX - active.startX;
        active.moved ||= isDragMovement(dx);
        if (!active.moved) return;
        const { width } = segmentsRef.current.getBoundingClientRect();
        setPreview(clamp(active.startPos + dx / (width / localizedModes.length)));
      };

      const endDrag = (event) => {
        const active = dragRef.current;
        if (active?.pointerId !== event.pointerId) return;
        finishDrag(event.pointerId);
        if (disabled) return;
        const { left, width } = segmentsRef.current.getBoundingClientRect();
        const step = width / localizedModes.length;
        const dx = event.clientX - active.startX;
        const target = active.moved || isDragMovement(dx)
          ? Math.round(clamp(active.startPos + dx / step))
          : clamp(Math.floor((event.clientX - left) / step));
        if (target === index) {
          if (pending !== null) onCancel();
          return;
        }
        onCommit(target);
      };

      const cancelDrag = (event) => {
        if (dragRef.current?.pointerId === event.pointerId) finishDrag(event.pointerId);
      };

      return h(
        'div',
        {
          className: `pnn-seg${preview !== null ? ' pnn-dragging' : ''}`,
          ref: trackRef,
          role: 'slider',
          tabIndex: disabled ? -1 : 0,
          'aria-label': text('density'),
          'aria-valuemin': 0,
          'aria-valuemax': last,
          'aria-valuenow': announced,
          'aria-valuetext': localizedModes[announced].label,
          'aria-disabled': disabled ? 'true' : undefined,
          style: { '--pnn-pos': String(position), '--pnn-segments': String(localizedModes.length) },
          onKeyDown,
          onPointerDown: startDrag,
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          onPointerCancel: cancelDrag,
          onLostPointerCapture: cancelDrag,
        },
        h(
          'div',
          { className: 'pnn-segments', ref: segmentsRef, 'aria-hidden': 'true' },
          localizedModes.map((mode) => h('span', { key: mode.id, className: 'pnn-segLabel' }, mode.label)),
          h(
            'div',
            { className: 'pnn-segPill' },
            h(
              'div',
              { className: 'pnn-segPillText' },
              localizedModes.map((mode) => h('span', { key: mode.id, className: 'pnn-segLabel' }, mode.label)),
            ),
          ),
        ),
      );
    }

    function Trigger() {
      useLocale();
      const isOpen = useOpen();
      const config = useConfig();
      const localizedModes = modes();
      const mode = useStableMode(config);
      const active = localizedModes.find((item) => item.id === mode) ?? localizedModes[1];
      const label = text('trigger', { mode: active.label });
      const tooltip = primitives?.Tooltip;
      const button = h(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          className: 'pnn-trigger',
          ...(tooltip === undefined || tooltip === null ? { title: label } : {}),
          'aria-label': label,
          'aria-haspopup': 'dialog',
          'aria-expanded': isOpen,
          onClick: () => setOpen(!open),
        },
        h(BubbleIcon, { kind: active.face, size: 16 }),
      );
      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        tooltip !== undefined && tooltip !== null
          ? h(tooltip, { label, side: 'top', portal: true, delayMs: 300 }, button)
          : button,
      );
    }

    function Overlay() {
      useLocale();
      const isOpen = useOpen();
      const config = useConfig();
      const mode = useStableMode(config);
      const localizedModes = modes();
      const index = Math.max(0, localizedModes.findIndex((item) => item.id === mode));
      const menuRef = useRef(null);
      const sliderRef = useRef(null);
      /** 已提交但宿主尚未确认的档位：胶囊先停在目标位置，等设置写入回来。 */
      const [pending, setPending] = useState(null);
      const lastIndexRef = useRef(index);
      const menuPos = primitives.useAnchoredPosition({
        open: isOpen,
        anchorRef: triggerRef,
        panelRef: menuRef,
        side: 'top',
        align: 'end',
        gap: 8,
        margin: 12,
      });
      const isPositioned = isOpen && menuPos != null;

      useEffect(() => {
        if (isPositioned) sliderRef.current?.focus({ preventScroll: true });
      }, [isPositioned]);

      useEffect(() => {
        if (!isOpen) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            triggerRef.current?.focus?.();
          }
        };
        const onPointerDown = (event) => {
          const menu = menuRef.current;
          if (menu !== null && menu.contains(event.target)) return;
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return;
          setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          window.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [isOpen]);

      /** 宿主档位一变就以宿主为准：要么正是待确认值（撤掉乐观态），要么是外部改动。 */
      useEffect(() => {
        if (lastIndexRef.current === index) return;
        lastIndexRef.current = index;
        setPending(null);
      }, [index]);

      if (!isOpen) return null;

      const active = localizedModes[index] ?? localizedModes[1];
      const isDefault = mode === 'balanced';

      /** 提交档位：先移动胶囊，再等宿主确认；被拒绝或写入失败才回退。 */
      const commit = (next) => {
        if (api === null) return;
        const writing = api.write('mode', MODE_DEFS[next].id);
        if (writing === false || writing === undefined || writing === null) return;
        setPending(next);
        if (typeof writing.then === 'function') {
          writing.then((accepted) => {
            if (accepted !== true) setPending(null);
          }, () => setPending(null));
        }
      };

      const render = typeof ReactDOM?.createPortal === 'function' ? ReactDOM.createPortal : (node) => node;
      return render(
        h(
          primitives.MenuSurface,
          {
            ref: menuRef,
            role: 'dialog',
            'aria-label': text('panel'),
            className: 'pnn-menu',
            style: menuPos ?? MEASURE_STYLE,
          },
          h('style', null, CSS),
          h(
            'div',
            { className: 'pnn-panel' },
            h(
              'div',
              { className: 'pnn-head' },
              h(
                'div',
                { key: active.id, className: 'pnn-headMain' },
                h('span', { className: 'pnn-headIcon' }, h(BubbleIcon, { kind: active.face, size: 18 })),
                h('p', { className: 'pnn-caption' }, active.caption),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pnn-reset',
                  disabled: isDefault || config === null,
                  title: text('reset'),
                  'aria-label': text('reset'),
                  onClick: () => {
                    sliderRef.current?.focus({ preventScroll: true });
                    commit(1);
                  },
                },
                h(
                  'svg',
                  {
                    width: '16',
                    height: '16',
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '1.5',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                    'aria-hidden': 'true',
                  },
                  h('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
                  h('path', { d: 'M3 3v5h5' }),
                ),
              ),
            ),
            h(DensitySlider, {
              index,
              pending,
              trackRef: sliderRef,
              modes: localizedModes,
              disabled: config === null,
              onCommit: commit,
              onCancel: () => setPending(null),
            }),
          ),
        ),
        document.body,
      );
    }

    return {
      inject: ['slots', 'configForms', 'locale'],
      apply(ctx) {
        try {
        /** 语言服务：缺失时（测试桩、退化组合）只影响文案语言，不影响功能。 */
        localeFace = ctx.locale ?? null;
        if (localeFace !== null && typeof localeFace.register === 'function') {
          ctx.effect(() => {
            const disposers = [];
            for (const [id, dict] of Object.entries(DICTS)) {
              try {
                disposers.push(localeFace.register(NS, id, dict));
              } catch (error) {
                const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
                if (!/already has locale/.test(message)) throw error;
              }
            }
            return () => disposers.forEach((dispose) => dispose());
          }, 'progress-narration: dictionaries');
        }

        const forms = [];
        for (const id of ENTRY_IDS) {
          try {
            forms.push(ctx.configForms.get(id));
          } catch (error) {
            /* 某个候选 id 不可用时继续用另一个 */
          }
        }

        const readyForm = () => {
          for (const form of forms) {
            const snapshot = form.getSnapshot();
            if (snapshot !== undefined && snapshot.status === 'ready') return { form, snapshot };
          }
          return null;
        };

        api = {
          read() {
            const ready = readyForm();
            if (ready === null) return null;
            const value = ready.snapshot.value ?? {};
            return { mode: normalizeMode(value.mode) };
          },
          subscribe(listener) {
            const disposers = forms.map((form) => form.subscribe(listener));
            return () => disposers.forEach((dispose) => dispose());
          },
          write(field, value) {
            const ready = readyForm();
            if (ready === null) return false;
            return ready.form.set(field, value);
          },
        };

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'progress-narration', order: 40 }, Trigger),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'progress-narration', order: 60 }, Overlay),
        );
        } catch (error) {
          // 插件内部错误不应影响其他插件与整个页面的启动
          if (typeof console !== 'undefined') console.warn('[process narration] unavailable:', error);
        }
      },
    };
  },
});
