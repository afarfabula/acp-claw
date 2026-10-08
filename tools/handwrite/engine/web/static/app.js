/* 手写作业生成器 —— 前端交互
 *
 * 结构参考 Overleaf：左侧源码/参数 + 右侧 PDF 预览 + 手动 Recompile。
 * 参数面板由 CONTROL_SPEC 描述、自动生成，字段名与后端 render.RenderParams 一一对应。
 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const PRINT_WIDTH = 794;   // A4 在 96dpi 下的 CSS 宽度，100% 缩放基准

  const CONTROL_SPEC = [
    { panel: 'layout', group: '纸张', items: [
      { key: 'page_size', label: '纸张尺寸', type: 'select', options: [
        ['A4', 'A4 · 210×297mm'], ['A5', 'A5 · 148×210mm'],
        ['B5', 'B5 · 176×250mm'], ['Letter', 'Letter · 215.9×279.4mm'],
      ], hint: '作业交作业就用 A4。' },
      { key: 'dpi', label: '分辨率', type: 'range', min: 100, max: 300, step: 10, unit: ' dpi',
        hint: '像素 = 毫米 × dpi / 25.4。150dpi 时 A4 = 1240×1754px，够打印；调高更清晰也更慢。' },
      { key: 'margin', label: '页边距', type: 'range', min: 20, max: 200, step: 2, unit: ' px',
        hint: '70px @150dpi ≈ 12mm。' },
    ]},
    { panel: 'layout', group: '字号与行距', items: [
      { key: 'font_size', label: '字号', type: 'range', min: 16, max: 90, step: 1, unit: ' px',
        hint: '38px @150dpi ≈ 18pt，接近手写体大小。' },
      { key: 'line_spacing', label: '行距', type: 'range', min: 20, max: 200, step: 1, unit: ' px',
        hint: '必须 ≥ 字号（否则排版引擎会报错，服务端会自动上调）。' },
      { key: 'line_spacing_sigma', label: '行距抖动 σ', type: 'range', min: 0, max: 20, step: 0.1, unit: ' px',
        hint: '每个字的基线上下抖动的标准差：写在没有格子的纸上就是这种感觉。' },
      { key: 'font_size_sigma', label: '字号抖动 σ', type: 'range', min: 0, max: 8, step: 0.1, unit: ' px',
        hint: '字忽大忽小的程度。每个字都要重建字体对象，所以它最吃性能，设 0 明显更快。' },
      { key: 'word_spacing', label: '字距微调', type: 'number', min: -18, max: 40, step: 1, unit: ' px',
        hint: '负数更挤。下限是 -字号/2。' },
      { key: 'word_spacing_sigma', label: '字距抖动 σ', type: 'range', min: 0, max: 12, step: 0.1, unit: ' px',
        hint: '字距忽紧忽松的程度。' },
    ]},
    { panel: 'layout', group: '渲染质量（笔迹平滑度）', items: [
      { key: 'supersample', label: '抗锯齿倍数（超采样）', type: 'select', options: [
        ['1', '1×　关闭抗锯齿 —— 纯 1 位硬边，笔画会发毛、最快'],
        ['2', '2×　推荐 —— 双倍分辨率渲染再降采样，笔迹平滑'],
        ['3', '3×　最细腻 —— 约 2 倍耗时'],
      ], hint: 'Handright 输出的是纯 1 位像素，边缘是硬的：直接看会觉得笔画断成虚线、发灰。'
             + '2× 超采样后笔迹平滑，观感和把 PDF 放进阅读器里看到的一致（默认值，和压缩包原版观感对齐）。' },
    ]},
    { panel: 'layout', group: '和压缩包原始实现对账', items: [
      { key: '__preset_cli', label: '一键对齐', type: 'presets', presetKind: 'cli',
        hint: '把全部参数换成 handwrite.py 的默认值（正文不动），等于压缩包 CLI 跑出来的效果。' },
      { key: '__parity', label: '当前参数', type: 'parity' },
    ]},

    { panel: 'hand', group: '手感预设', items: [
      { key: '__preset_hand', label: '一键切换', type: 'presets', presetKind: 'handwriting',
        hint: '只改抖动相关的参数，其它保持不变。' },
    ]},
    { panel: 'hand', group: '笔迹抖动（越小越工整）', items: [
      { key: 'jitter_x', label: '横向位移 σ', type: 'range', min: 0, max: 12, step: 0.1, unit: ' px',
        hint: '每个笔画左右随机移动的幅度。' },
      { key: 'jitter_y', label: '纵向位移 σ', type: 'range', min: 0, max: 12, step: 0.1, unit: ' px',
        hint: '每个笔画上下随机移动的幅度。' },
      { key: 'perturb_theta', label: '旋转抖动 σ', type: 'range', min: 0, max: 0.4, step: 0.005, unit: ' rad',
        hint: '每个笔画绕自身中心旋转的角度标准差。0.06 rad ≈ 3.4°，0.12 ≈ 6.9°。' },
      { key: 'seed', label: '随机种子', type: 'text', placeholder: '留空 = 每次都不一样',
        hint: '填一个字符串，同样的内容+参数就能复现同一份手写。' },
      { key: 'grid_layout', label: '格子对齐排版', type: 'bool',
        hint: 'Handright 的实验特性：字按等宽格子摆放（配合方格本更像格子本作业）。' },
    ]},
    { panel: 'hand', group: '避头尾（禁则处理）', items: [
      { key: 'end_chars', label: '不允许在行首的字符', type: 'text',
        hint: '默认包含中文标点，保证句号/逗号不会跑到行首。' },
      { key: 'start_chars', label: '不允许在行尾的字符', type: 'text',
        hint: '默认留空；比如填「（〈【 就能避免左括号留在行尾。' },
    ]},

    { panel: 'paper', group: '纸张预设', items: [
      { key: '__preset_paper', label: '一键切换', type: 'presets', presetKind: 'paper' },
    ]},
    { panel: 'paper', group: '纸张', items: [
      { key: 'paper', label: '纸型', type: 'select', options: [
        ['blank', '纯色纸'], ['lined', '横线本'], ['grid', '方格本'],
      ]},
      { key: 'paper_color', label: '纸色', type: 'color' },
      { key: 'rule_color', label: '线条颜色', type: 'color' },
      { key: 'rule_spacing', label: '线条间距', type: 'range', min: 0, max: 200, step: 1, unit: ' px',
        hint: '0 = 跟随行距。' },
      { key: 'margin_line', label: '左侧红色竖线', type: 'bool' },
      { key: 'margin_line_color', label: '竖线颜色', type: 'color' },
    ]},
    { panel: 'paper', group: '墨色', items: [
      { key: '__preset_ink', label: '常用墨色', type: 'presets', presetKind: 'ink' },
      { key: 'ink', label: '墨色', type: 'color',
        hint: '想要蓝笔就选 #12305f 之类；深色墨（亮度<90）才适合 CCITT G4 单色输出。' },
    ]},

    { panel: 'out', group: 'PDF 输出', items: [
      { key: 'pdf_mode', label: '压缩方式', type: 'select', options: [
        ['lossless', '无损（FlateDecode，支持彩色墨）'],
        ['g4', '极小（CCITT G4 单色，约 1/10 体积）'],
        ['jpeg', '兼容最好（JPEG，有损）'],
      ], hint: '默认无损：墨色完全准确，体积也只有 JPEG 的五分之一左右。' },
      { key: 'jpeg_quality', label: 'JPEG 质量', type: 'range', min: 40, max: 100, step: 1,
        hint: '仅在「JPEG」模式下生效。' },
      { key: 'filename', label: '下载文件名', type: 'text', placeholder: '手写作业.pdf', noParam: true },
    ]},
  ];

  const state = {
    params: {},
    defaults: {},
    cliDefaults: {},
    parityFields: [],
    exampleParams: {},
    fonts: [],
    presets: { handwriting: {}, ink: {}, paper: {} },
    text: '',
    view: 'image',
    zoom: null,          // 像素宽度；null = 适合宽度
    dirty: false,
    rendering: false,
    queued: false,
    skipHistory: false,
    history: [],         // 参数历史：每次成功渲染后压入一套参数，供「撤销参数」回退
    job: null,
    pdfUrl: null,
    autoTimer: null,
    leftWidth: null,
    auto: false,
  };

  const store = {
    key: 'handwrite-web-state-v1',
    _timer: null,
    save() {
      try {
        localStorage.setItem(this.key, JSON.stringify({
          text: state.text, params: state.params,
          filename: $('#ctl-filename')?.value || '',
          auto: state.auto, view: state.view, leftWidth: state.leftWidth,
          zoom: state.zoom === null ? 'fit' : state.zoom,
          history: state.history.slice(0, 12),
        }));
      } catch (e) { /* 隐私模式忽略 */ }
    },
    saveSoon() {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.save(), 500);
    },
    load() {
      try { return JSON.parse(localStorage.getItem(this.key) || '{}'); }
      catch (e) { return {}; }
    },
  };

  // ————————————————— 初始化 —————————————————

  let editor = null;

  function initEditor(doc) {
    const HW = window.HWEditor;
    editor = new HW.EditorView({
      doc,
      parent: $('#editor'),
      extensions: [
        HW.lineNumbers(),
        HW.history(),
        HW.drawSelection(),
        HW.highlightActiveLine(),
        HW.highlightSelectionMatches(),
        HW.EditorView.lineWrapping,
        HW.keymap.of([
          { key: 'Mod-Enter', run: () => { compile(); return true; } },
          { key: 'Mod-s', run: () => { download(); return true; } },
          { key: 'Alt-z', run: () => { undoParams(); return true; } },
          ...HW.defaultKeymap,
          ...HW.historyKeymap,
          ...HW.searchKeymap,
          HW.indentWithTab,
        ]),
        HW.EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            state.text = u.state.doc.toString();
            markDirty();
            updateTextStats();
            store.saveSoon();
            scheduleAuto();
          }
        }),
        HW.EditorView.theme({
          '&': { height: '100%' },
          '.cm-content': { caretColor: '#138a07' },
          '.cm-line': { padding: '0 2px' },
          '.cm-selectionBackground, ::selection': { backgroundColor: '#d7ecd2 !important' },
        }),
      ],
    });
  }

  async function boot() {
    const saved = store.load();
    let cfg = { defaults: {}, fonts: [], presets: { handwriting: {}, ink: {}, paper: {} } };
    try {
      cfg = await (await fetch('/api/config')).json();
    } catch (e) {
      showAlert('无法连接后端服务，请确认服务已启动。\n' + e);
      return;
    }
    state.defaults = cfg.defaults;
    state.cliDefaults = cfg.cli_defaults || cfg.defaults;
    state.parityFields = cfg.parity_fields || [];
    state.exampleParams = cfg.example_params || {};
    state.fonts = cfg.fonts;
    state.presets = cfg.presets;
    state.params = Object.assign({}, cfg.defaults, saved.params || {});
    delete state.params.filename_hint;
    state.text = typeof saved.text === 'string' ? saved.text : '';
    state.auto = !!saved.auto;
    state.view = saved.view || 'image';
    state.leftWidth = saved.leftWidth || null;
    state.zoom = saved.zoom && saved.zoom !== 'fit' ? saved.zoom : null;
    state.history = Array.isArray(saved.history) ? saved.history : [];

    $('#auto-compile').checked = state.auto;
    if (state.leftWidth) {
      document.documentElement.style.setProperty('--left-width', state.leftWidth + 'px');
    }
    if (saved.filename) { /* 文件名稍后设置 */ }

    buildControls();
    buildFontPanel();
    initEditor(state.text);
    bindChrome();
    updateUndoButton();
    if (saved.filename) {
      const input = $('#ctl-filename');
      if (input) input.value = saved.filename;
    }
    syncControls();
    updateTextStats();
    setView(state.view, true);
    applyZoom();
    updateDownload();
    if (state.text.trim()) {
      compile({ silent: true });
    }
  }

  // ————————————————— 参数面板 —————————————————

  function panelEl(panel) { return $(`.tab-panel[data-panel="${panel}"]`); }

  function buildControls() {
    CONTROL_SPEC.forEach((block) => {
      const host = panelEl(block.panel);
      if (!host) return;
      let group = host.querySelector(`.ctrl-group[data-group="${block.group}"]`);
      if (!group) {
        group = document.createElement('div');
        group.className = 'ctrl-group';
        group.dataset.group = block.group;
        const h = document.createElement('h3');
        h.textContent = block.group;
        group.appendChild(h);
        const controls = host.querySelector('.controls');
        controls.appendChild(group);
      }
      block.items.forEach((item) => group.appendChild(buildField(item)));
    });
  }

  function buildField(item) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.field = item.key;

    if (item.type === 'presets') {
      const row = document.createElement('div');
      row.className = 'preset-row';
      Object.keys(state.presets[item.presetKind] || {}).forEach((name) => {
        const btn = document.createElement('button');
        btn.className = 'preset';
        btn.type = 'button';
        btn.textContent = name;
        btn.addEventListener('click', () => {
          Object.assign(state.params, state.presets[item.presetKind][name]);
          syncControls();
          markDirty({ structural: true });
        });
        row.appendChild(btn);
      });
      wrap.appendChild(row);
      if (item.hint) {
        const hint = document.createElement('div');
        hint.className = 'field-hint';
        hint.textContent = item.hint;
        wrap.appendChild(hint);
      }
      return wrap;
    }

    if (item.type === 'parity') {
      const row = document.createElement('div');
      row.className = 'parity-row';
      const chip = document.createElement('span');
      chip.className = 'parity';
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.type = 'button';
      btn.textContent = '↺ 恢复压缩包默认并重渲染';
      btn.addEventListener('click', () => applyCliDefaults());
      row.appendChild(chip);
      row.appendChild(btn);
      wrap.appendChild(row);
      if (item.hint) {
        const hint = document.createElement('div');
        hint.className = 'field-hint';
        hint.textContent = item.hint;
        wrap.appendChild(hint);
      }
      return wrap;
    }

    const head = document.createElement('div');
    head.className = 'field-head';
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = item.label;
    label.htmlFor = 'ctl-' + item.key;
    head.appendChild(label);

    const valueTag = document.createElement('span');
    valueTag.className = 'field-value';

    let input;
    const isNumber = item.type === 'range' || item.type === 'number';

    if (item.type === 'range' || item.type === 'number') {
      input = document.createElement('input');
      input.type = item.type === 'range' ? 'range' : 'number';
      input.id = 'ctl-' + item.key;
      input.min = item.min;
      input.max = item.max;
      input.step = item.step || 1;
      input.addEventListener('input', () => {
        state.params[item.key] = Number(input.value);
        renderValue(valueTag, item, input.value);
        onParamInput(item, { structural: item.type === 'number' });
      });
      if (item.type === 'number') {
        input.addEventListener('change', () => {
          if (input.value === '') input.value = state.params[item.key];
        });
      }
    } else if (item.type === 'select') {
      input = document.createElement('select');
      input.id = 'ctl-' + item.key;
      item.options.forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        input.appendChild(opt);
      });
      input.addEventListener('change', () => {
        state.params[item.key] = input.value;
        syncControls();
        onParamInput(item, { structural: true });
      });
    } else if (item.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'ctl-' + item.key;
      const row = document.createElement('div');
      row.className = 'toggle-row';
      const text = document.createElement('span');
      text.className = 'field-label';
      text.textContent = item.label;
      label.remove();
      row.appendChild(text);
      row.appendChild(input);
      head.innerHTML = '';
      head.appendChild(row);
      input.addEventListener('change', () => {
        state.params[item.key] = input.checked;
        onParamInput(item, { structural: true });
      });
    } else if (item.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.id = 'ctl-' + item.key;
      const text = document.createElement('input');
      text.type = 'text';
      text.className = 'hex';
      const row = document.createElement('div');
      row.className = 'field-row';
      row.appendChild(input);
      row.appendChild(text);
      input.addEventListener('input', () => {
        state.params[item.key] = input.value;
        text.value = input.value;
        onParamInput(item, {});
      });
      text.addEventListener('change', () => {
        const v = text.value.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
          const hex = '#' + v.replace('#', '').toLowerCase();
          state.params[item.key] = hex;
          input.value = hex;
          onParamInput(item, {});
        } else {
          text.value = state.params[item.key] || '';
        }
      });
      input.dataset.hexPartner = '1';
      input._hexText = text;
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.id = 'ctl-' + item.key;
      if (item.placeholder) input.placeholder = item.placeholder;
      input.addEventListener('input', () => {
        state.params[item.key] = input.value;
        onParamInput(item, {});
      });
    }

    if (isNumber) head.appendChild(valueTag);
    wrap.appendChild(head);

    if (item.type === 'color') {
      wrap.appendChild(input._hexText.parentElement);
      input._hexText.value = state.params[item.key] || '#000000';
      delete input._hexText;
    } else {
      wrap.appendChild(input);
    }

    if (item.hint) {
      const hint = document.createElement('div');
      hint.className = 'field-hint';
      hint.textContent = item.hint;
      wrap.appendChild(hint);
    }
    wrap._item = item;
    return wrap;
  }

  function renderValue(tag, item, raw) {
    const v = Number(raw);
    tag.textContent = (item.step && String(item.step).includes('.'))
      ? v.toFixed(String(item.step).split('.')[1].length) + (item.unit || '')
      : String(v) + (item.unit || '');
  }

  /** 把所有控件同步成 state.params 的值 */
  function syncControls() {
    CONTROL_SPEC.forEach((block) => block.items.forEach((item) => {
      if (item.type === 'presets') return;
      if (item.type === 'parity') return;
      const wrap = $(`.field[data-field="${item.key}"]`);
      if (!wrap) return;
      const input = wrap.querySelector('input, select');
      if (!input) return;
      const value = state.params[item.key];
      if (item.type === 'bool') input.checked = !!value;
      else if (item.type === 'color') {
        input.value = value || '#000000';
        const hex = wrap.querySelector('input.hex');
        if (hex) hex.value = value || '';
      } else input.value = value ?? '';
      const tag = wrap.querySelector('.field-value');
      if (tag && (item.type === 'range' || item.type === 'number')) {
        renderValue(tag, item, input.value);
      }
    }));
    // 联动：非 JPEG 模式时灰掉质量滑块
    const qWrap = $('.field[data-field="jpeg_quality"]');
    if (qWrap) qWrap.style.opacity = state.params.pdf_mode === 'jpeg' ? '1' : '.45';
    // 联动：非横线/方格时灰掉线条颜色
    ['rule_color', 'rule_spacing', 'margin_line', 'margin_line_color'].forEach((key) => {
      const w = $(`.field[data-field="${key}"]`);
      if (w) w.style.opacity = state.params.paper === 'blank' ? '.45' : '1';
    });
    // 字体是卡片式选择，不在 CONTROL_SPEC 里，单独同步一下高亮
    $$('.font-card').forEach((c) => c.classList.toggle('is-active', c.dataset.font === state.params.font));
    updateParity();
  }

  /** 哪些"观感参数"偏离了 handwrite.py 的默认值 */
  function parityDiffKeys() {
    const fields = state.parityFields;
    const cli = state.cliDefaults;
    if (!fields.length) return [];
    const same = (a, b) => {
      const sa = String(a ?? '').trim();
      const sb = String(b ?? '').trim();
      const na = Number(sa);
      const nb = Number(sb);
      if (sa !== '' && sb !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
      return sa.toLowerCase() === sb.toLowerCase();
    };
    return fields.filter((k) => !same(state.params[k], cli[k]));
  }

  function updateParity() {
    if (!state.parityFields.length) return;
    const diff = parityDiffKeys();
    const text = diff.length ? `偏离压缩包默认 ${diff.length} 项` : '与压缩包默认一致 ✓';
    $$('.parity').forEach((el) => {
      el.textContent = text;
      el.classList.toggle('is-off', diff.length > 0);
      el.title = diff.length
        ? `与 handwrite.py 默认值不同的参数（${diff.length} 项）：${diff.join('、')}\n点右边按钮可一键对齐`
        : `这 ${state.parityFields.length} 项观感参数与 handwrite.py（压缩包原始实现）的默认值完全一致`;
    });
  }

  /** 一键回到压缩包原始实现的参数，并立刻重渲染 */
  function applyCliDefaults() {
    state.params = Object.assign({}, state.defaults, state.cliDefaults);
    delete state.params.filename_hint;
    syncControls();
    store.save();
    markDirty({ skipAuto: true });
    setLog('[参数] 已恢复为 handwrite.py（压缩包原始实现）的默认参数，正在重新渲染…');
    compile();
  }

  function onParamInput(item, opts) {
    store.save();
    markDirty(opts);
    if (item.key === 'page_size' || item.key === 'dpi' || item.key === 'paper') syncControls();
    updateParity();
    updateTextStats();
  }

  function markDirty(opts) {
    state.dirty = true;
    setStatus('dirty');
    $('#btn-compile').classList.add('is-dirty');
    $('#dirty-dot').className = 'dot is-dirty';
    $('#footer-text').textContent = '有改动，待渲染';
    store.saveSoon();
    if (!opts || !opts.skipAuto) scheduleAuto();
  }

  function scheduleAuto() {
    if (!state.auto) return;
    clearTimeout(state.autoTimer);
    state.autoTimer = setTimeout(() => compile(), 900);
  }

  // ————————————————— 字体面板 —————————————————

  function buildFontPanel() {
    const host = panelEl('font').querySelector('.controls');
    host.innerHTML = '';

    const group = document.createElement('div');
    group.className = 'ctrl-group';
    const h = document.createElement('h3');
    h.textContent = '手写体（已自动补齐数学符号）';
    group.appendChild(h);

    state.fonts.forEach((f) => {
      const card = document.createElement('div');
      card.className = 'font-card' + (f.id === state.params.font ? ' is-active' : '');
      card.dataset.font = f.id;
      card.innerHTML = `
        <div class="font-card-body">
          <div class="font-card-name">${escapeHtml(f.label)}</div>
          <div class="font-card-meta">${escapeHtml(f.family)} · ${f.size_kb} KB · GB2312 ${f.coverage}%</div>
        </div>`;
      card.addEventListener('click', () => {
        state.params.font = f.id;
        $$('.font-card').forEach((c) => c.classList.toggle('is-active', c.dataset.font === f.id));
        markDirty({ structural: true });
        store.save();
      });
      group.appendChild(card);
    });
    host.appendChild(group);

    const upGroup = document.createElement('div');
    upGroup.className = 'ctrl-group';
    upGroup.innerHTML = `<h3>上传自己的手写体</h3>
      <div class="uploader" id="uploader">
        <input type="file" id="font-file" accept=".ttf,.otf,.ttc">
        <div>把 ttf 拖到这里，或 <label for="font-file">选择文件</label></div>
        <div class="upload-hint" style="margin-top:6px">上传后服务端会用 fontTools 把它和 DejaVu Serif 合并，
        自动补齐 α λ Σ ‖ ᴴ 等数学符号（约 5 秒）。</div>
      </div>
      <div class="field-hint" id="upload-status"></div>`;
    host.appendChild(upGroup);

    const input = $('#font-file', upGroup);
    const uploader = $('#uploader', upGroup);
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) uploadFont(input.files[0]);
    });
    ['dragenter', 'dragover'].forEach((ev) => uploader.addEventListener(ev, (e) => {
      e.preventDefault(); uploader.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => uploader.addEventListener(ev, (e) => {
      e.preventDefault(); uploader.classList.remove('is-over');
    }));
    uploader.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) uploadFont(file);
    });
  }

  async function uploadFont(file) {
    const status = $('#upload-status');
    status.textContent = `正在上传并合并 ${file.name}（约 5 秒）…`;
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const res = await fetch('/api/fonts', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
      state.fonts = data.fonts;
      state.params.font = data.font.id;
      status.textContent = `已加入字体库：${data.font.label}（${data.elapsed_ms} ms）`;
      buildFontPanel();
      markDirty({ structural: true });
      store.save();
    } catch (e) {
      status.textContent = '上传失败：' + e.message;
    }
  }

  // ————————————————— 渲染 —————————————————

  async function compile(opts = {}) {
    if (state.rendering) { state.queued = true; return; }
    state.rendering = true;
    setStatus('running');
    $('#btn-compile').disabled = true;
    $('#loading').hidden = false;
    hideAlert();

    // 记下这次真正提交出去的内容：返回时用来判断"用户在这期间又改了没有"
    const sentText = state.text;
    const sentParams = cleanParams(state.params);
    const payload = { text: sentText, params: sentParams };
    const t0 = performance.now();
    try {
      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));

      state.job = data.job;
      state.pdfUrl = data.pdf_url;
      const echo = data.params_echo ? cleanParams(data.params_echo) : sentParams;

      // 只把"服务端纠偏过的字段"写回去，而且只在用户没动过那个字段时写。
      // 否则渲染期间用户新改的参数会被这次响应悄悄改回旧值（超采样后渲染要几秒，很容易撞上）。
      let corrected = false;
      Object.keys(echo).forEach((key) => {
        const before = sentParams[key];
        const after = echo[key];
        if (String(before) === String(after)) return;               // 服务端没改
        if (String(state.params[key]) !== String(before)) return;   // 用户已经又改过了，尊重用户
        state.params[key] = after;
        corrected = true;
      });
      if (corrected) syncControls();

      const staleParams = JSON.stringify(cleanParams(state.params)) !== JSON.stringify(sentParams);
      const staleText = state.text !== sentText;
      state.dirty = staleParams || staleText;

      if (state.skipHistory) {
        state.skipHistory = false;      // 撤销触发的重渲染，别把同一套参数又记一遍
      } else {
        pushHistory(echo, data.stats);  // 记录"这张图对应的参数"，而不是当前可能已被改动的参数
      }
      renderPages(data.pages);
      setLog(data.log + (state.dirty ? '\n[注意] 渲染期间你又改了' +
        (staleParams && staleText ? '正文和参数' : staleParams ? '参数' : '正文') +
        '，当前预览对应的是提交时的那份，再点一次「重新渲染」即可更新。' : ''), data.warnings);
      if (state.dirty) {
        setStatus('dirty');
        $('#dirty-dot').className = 'dot is-dirty';
        $('#btn-compile').classList.add('is-dirty');
        $('#footer-text').textContent =
          `已渲染（旧参数）· ${data.stats.pages} 页 · 期间有新的改动，待重渲染`;
      } else {
        setStatus('ok', `${data.stats.pages} 页`);
        $('#dirty-dot').className = 'dot is-ok';
        $('#footer-text').textContent =
          `已渲染 · ${data.stats.pages} 页 · ${data.stats.render_ms} ms · PDF ${data.pdf_kb} KB`;
        $('#btn-compile').classList.remove('is-dirty');
      }
      updateDownload();
      if (state.view === 'pdf') $('#pdf-frame').src = pdfUrlWithParams();
      applyZoom();
    } catch (e) {
      setStatus('error');
      $('#dirty-dot').className = 'dot is-error';
      showAlert(e.message || String(e));
      setLog(`[失败] ${e.message || e}`, [], false);
      $('#footer-text').textContent = '渲染失败';
    } finally {
      state.rendering = false;
      $('#btn-compile').disabled = false;
      $('#loading').hidden = true;
      if (state.queued) { state.queued = false; compile(); }
      else if (state.auto && state.dirty) scheduleAuto();
    }
  }

  function cleanParams(params) {
    const out = {};
    const fields = Object.keys(state.defaults).filter((k) => k !== 'filename_hint');
    fields.forEach((k) => {
      if (params[k] !== undefined && params[k] !== null) out[k] = params[k];
    });
    return out;
  }

  /** 每次成功渲染后，把这套参数压进历史（供「撤销参数」回退）。 */
  function pushHistory(params, stats) {
    const snapshot = cleanParams(params);
    const json = JSON.stringify(snapshot);
    if (state.history[0] && state.history[0].json === json) return;
    state.history.unshift({
      json,
      params: snapshot,
      at: Date.now(),
      pages: stats ? stats.pages : null,
      font: stats ? stats.font_label : '',
      dirtySnapshot: state.dirty,
    });
    state.history = state.history.slice(0, 12);
    store.saveSoon();
    updateUndoButton();
  }

  function updateUndoButton() {
    const btn = $('#btn-undo');
    if (!btn) return;
    const idx = undoTargetIndex();
    const steps = idx < 0 ? 0 : state.history.length - idx;
    btn.disabled = idx < 0;
    btn.style.opacity = idx < 0 ? '.45' : '1';
    btn.style.pointerEvents = idx < 0 ? 'none' : '';
    btn.title = idx < 0
      ? '还没有可回退的参数历史（渲染一次之后这里就能用）'
      : `回到上一次渲染所用的参数（还剩 ${steps} 步可退，Alt+Z）`;
  }

  /** 当前参数是否和某条历史完全一样 —— 用来判断该退到哪一条。 */
  function sameAsCurrent(entry) {
    return entry && entry.json === JSON.stringify(cleanParams(state.params));
  }

  /**
   * 撤销要退到哪一条历史：
   *  - 栈顶就是当前参数（刚渲染完的常见情况）→ 退到下一条，否则点了等于没点；
   *  - 栈顶和当前不同（改了参数还没渲染就点撤销）→ 就退到栈顶。
   */
  function undoTargetIndex() {
    if (!state.history.length) return -1;
    if (!sameAsCurrent(state.history[0])) return 0;
    return state.history.length > 1 ? 1 : -1;
  }

  /** 撤销参数：回退到上一次成功渲染时用的那套参数，并立刻重渲染。 */
  function undoParams() {
    const i = undoTargetIndex();
    if (i < 0) {
      setLog('[参数] 没有可回退的历史：渲染成功一次之后，这里会记住当时的参数。');
      return;
    }
    const entry = state.history[i];
    state.history = state.history.slice(i + 1);   // 被退回来的这条已变成当前状态，不必再留在历史里
    state.params = Object.assign({}, state.defaults, entry.params);
    delete state.params.filename_hint;
    syncControls();
    store.save();
    updateUndoButton();
    const secs = Math.max(0, Math.round((Date.now() - (entry.at || Date.now())) / 1000));
    const ago = secs < 60 ? `${secs} 秒前` : secs < 3600 ? `${Math.round(secs / 60)} 分钟前` : '更早';
    const when = secs < 90 ? '上一次' : ago;
    $('#footer-text').textContent = `已撤销参数，回到${when}那套（${entry.pages ?? '?'} 页 · ${entry.font || ''}）`;
    setLog(`[参数] 已回退到${when}渲染所用的参数，正在重新渲染…`, [], true);
    state.skipHistory = true;
    compile();
  }

  function renderPages(pages) {
    const host = $('#pages');
    host.innerHTML = '';
    if (!pages || !pages.length) return;
    pages.forEach((p) => {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.innerHTML = `
        <div class="page-label"><span>第 ${p.n} 页 / 共 ${pages.length} 页</span>
          <span>${p.w}×${p.h}px</span></div>
        <div class="paper"><img src="${p.url}" alt="第 ${p.n} 页" ${p.n === 1 ? '' : 'loading="lazy"'}></div>`;
      host.appendChild(wrap);
    });
    $('#empty-state').hidden = true;
    $('#page-info').textContent = `共 ${pages.length} 页`;
  }

  function pdfUrlWithParams() {
    if (!state.pdfUrl) return '';
    const name = ($('#ctl-filename')?.value || '手写作业').trim() || '手写作业';
    return state.pdfUrl + '?name=' + encodeURIComponent(name);
  }

  function updateDownload() {
    const a = $('#btn-download');
    if (!state.pdfUrl) { a.removeAttribute('href'); a.style.pointerEvents = 'none'; a.style.opacity = .5; return; }
    const name = ($('#ctl-filename')?.value || '手写作业').trim() || '手写作业';
    a.href = state.pdfUrl + '?dl=1&name=' + encodeURIComponent(name.endsWith('.pdf') ? name : name + '.pdf');
    a.style.pointerEvents = '';
    a.style.opacity = 1;
  }

  function download() {
    if (!state.pdfUrl) return;
    const a = document.createElement('a');
    a.href = state.pdfUrl + '?dl=1&name=' +
      encodeURIComponent(($('#ctl-filename')?.value || '手写作业').trim() || '手写作业');
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function setStatus(kind, detail) {
    const pill = $('#status-pill');
    const map = {
      idle: ['未渲染', 'idle'], running: ['渲染中…', 'running'],
      ok: ['已更新', 'ok'], dirty: ['有改动', 'dirty'], error: ['失败', 'error'],
    };
    const [text, cls] = map[kind] || map.idle;
    pill.textContent = detail ? `${text} · ${detail}` : text;
    pill.dataset.state = cls;
  }

  function setLog(text, warnings = [], ok = true) {
    $('#log-body').textContent = text || '';
    const first = (text || '').split('\n')[0];
    $('#log-summary').textContent = first;
    $('#log-summary').style.color = ok ? '' : '#a12222';
  }

  function showAlert(msg) {
    const el = $('#alert');
    el.textContent = msg;
    el.hidden = false;
  }
  function hideAlert() { $('#alert').hidden = true; }

  // ————————————————— 缩放 / 视图 —————————————————

  function setPaperWidth(px) {
    document.documentElement.style.setProperty('--paper-w', Math.round(px) + 'px');
    const label = $('#zoom-label');
    if (label) {
      // 始终显示百分比（相对 A4 实际打印尺寸），适合宽度模式下也给出具体值
      label.textContent = Math.round(px / PRINT_WIDTH * 100) + '%';
      label.title = state.zoom === null ? '当前：适合宽度（点击切换）' : '点击适合宽度';
      label.classList.toggle('is-fit', state.zoom === null);
    }
  }

  function applyZoom() {
    const body = $('#preview-body');
    if (state.zoom === null) {
      const w = Math.max(240, body.clientWidth - 56);
      setPaperWidth(w);
    } else {
      setPaperWidth(state.zoom);
    }
  }

  function zoomBy(factor) {
    const body = $('#preview-body');
    const current = state.zoom === null ? Math.max(240, body.clientWidth - 56) : state.zoom;
    state.zoom = Math.min(4000, Math.max(200, current * factor));
    setPaperWidth(state.zoom);
    store.save();
  }

  function setView(view, silent) {
    if (view === 'pdf' && !state.pdfUrl) view = 'image';
    state.view = view;
    $$('#view-switch button').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    const isPdf = view === 'pdf';
    $('#pages').hidden = isPdf;
    $('#empty-state').hidden = isPdf || !!state.job;
    $('#pdf-hint').hidden = !isPdf || !state.pdfUrl;
    const frame = $('#pdf-frame');
    frame.hidden = !isPdf;
    if (isPdf && state.pdfUrl) {
      frame.src = pdfUrlWithParams();
      const open = $('#pdf-open');
      if (open) open.href = pdfUrlWithParams();
    }
    if (!silent) store.save();
  }

  // ————————————————— 其它交互 —————————————————

  function updateTextStats() {
    const text = state.text || '';
    const lines = text ? text.split('\n').length : 1;
    const est = estimatePages(text);
    $('#text-stats').textContent = `${text.length} 字 · ${lines} 行 · 约 ${est} 页`;
  }

  function estimatePages(text) {
    const p = state.params;
    const dims = { A4: [210, 297], A5: [148, 210], B5: [176, 250], Letter: [215.9, 279.4] };
    const [wmm, hmm] = dims[p.page_size] || [210, 297];
    const dpi = p.dpi || 150;
    const w = Math.round(wmm / 25.4 * dpi);
    const h = Math.round(hmm / 25.4 * dpi);
    const usableW = w - 2 * p.margin;
    const usableH = h - 2 * p.margin;
    if (usableW <= 0 || usableH <= 0) return 0;
    const perLine = Math.max(1, Math.floor(usableW / (p.font_size * 0.92 + p.word_spacing)));
    const perPage = Math.max(1, Math.floor(usableH / p.line_spacing));
    let lines = 0;
    text.split('\n').forEach((para) => {
      lines += para ? Math.max(1, Math.ceil(para.length / perLine)) : 1;
    });
    return Math.max(1, Math.ceil(lines / perPage));
  }

  function bindChrome() {
    $('#btn-compile').addEventListener('click', () => compile());
    $('#btn-download').addEventListener('click', (e) => { e.preventDefault(); download(); });
    $('#auto-compile').addEventListener('change', (e) => {
      state.auto = e.target.checked;
      store.save();
      if (state.auto && state.dirty) scheduleAuto();
    });

    $('#tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab));
      if (tab.dataset.tab === 'text' && editor) editor.requestMeasure();
    });

    $('#btn-example').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/example');
        const data = await res.json();
        if (data.ok === false) throw new Error(data.error || '示例不可用');
        // 正文 + **全部参数**一起覆盖，任何被调坏的状态都能一键回到推荐效果
        if (data.params && Object.keys(data.params).length) {
          state.params = Object.assign({}, state.defaults, data.params);
          delete state.params.filename_hint;
        }
        setDoc(data.text || '');
        syncControls();
        store.save();
        $('#footer-text').textContent = '已载入示例：正文 + 全部参数都换成推荐值';
        setLog('[示例] 已载入示例正文，并把全部参数重置为推荐值（龙藏体 + 白纸 + 黑笔 + 自然手感），开始渲染…');
        compile();
      } catch (e) { showAlert('示例文本加载失败：' + e); }
    });
    $('#btn-undo').addEventListener('click', () => undoParams());
    $('#btn-clear').addEventListener('click', () => setDoc(''));
    $('#btn-reset').addEventListener('click', () => applyCliDefaults());

    $('#view-switch').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (btn) setView(btn.dataset.view);
    });

    $('#zoom-in').addEventListener('click', () => zoomBy(1.15));
    $('#zoom-out').addEventListener('click', () => zoomBy(1 / 1.15));
    $('#zoom-fit').addEventListener('click', () => { state.zoom = null; applyZoom(); store.save(); });
    $('#zoom-reset').addEventListener('click', () => { state.zoom = PRINT_WIDTH; setPaperWidth(PRINT_WIDTH); store.save(); });
    $('#zoom-label').addEventListener('click', () => { state.zoom = null; applyZoom(); store.save(); });
    window.addEventListener('resize', () => { if (state.zoom === null) applyZoom(); });

    $('#log-toggle').addEventListener('click', () => {
      const bar = $('#logbar');
      const open = bar.classList.toggle('is-open');
      $('#log-body').hidden = !open;
    });

    // 分隔条拖拽
    const splitter = $('#splitter');
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const x = (e.touches ? e.touches[0].clientX : e.clientX);
      const total = $('#workspace').clientWidth;
      const width = Math.min(Math.max(x, 300), total - 340);
      document.documentElement.style.setProperty('--left-width', width + 'px');
      state.leftWidth = width;
      if (state.zoom === null) applyZoom();
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('is-dragging');
      store.save();
    };
    splitter.addEventListener('mousedown', (e) => { dragging = true; splitter.classList.add('is-dragging'); e.preventDefault(); });
    splitter.addEventListener('touchstart', (e) => { dragging = true; splitter.classList.add('is-dragging'); });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
    splitter.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0;
      if (!step) return;
      e.preventDefault();
      const cur = $('.pane-left').clientWidth + step;
      const total = $('#workspace').clientWidth;
      const width = Math.min(Math.max(cur, 300), total - 340);
      document.documentElement.style.setProperty('--left-width', width + 'px');
      state.leftWidth = width;
      applyZoom();
    });

    // 文件名变化时刷新下载链接
    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'ctl-filename') { updateDownload(); store.saveSoon(); }
    });

    window.addEventListener('beforeunload', () => store.save());

    // 不在编辑器里时也能用 Alt+Z 撤销参数
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey) {
        const active = document.activeElement;
        const inText = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT');
        if (!inText) { e.preventDefault(); undoParams(); }
      }
    });
  }

  function setDoc(text) {
    const HW = window.HWEditor;
    if (!editor) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
    });
    state.text = text;
    updateTextStats();
    store.save();
    scheduleAuto();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
