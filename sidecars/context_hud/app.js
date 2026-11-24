(() => {
  const params = new URLSearchParams(window.location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';
  const apiFetch = (url, opts) => (window.sidecar?.fetch ? window.sidecar.fetch(url, opts) : fetch(url, opts));

  const state = {
    tab: 'hud',
    hud: null,
    mri: null,
    mriDays: 7,
    mriCatFilter: null,
    lastHandoff: null,
    exporting: false,
    pollTimer: null,
  };

  const els = {
    tabs: [...document.querySelectorAll('.tab')],
    panelHud: document.getElementById('panel-hud'),
    panelMri: document.getElementById('panel-mri'),
    hudRoot: document.getElementById('hud-root'),
    mriRoot: document.getElementById('mri-root'),
    liveDot: document.getElementById('live-dot'),
    refreshBtn: document.getElementById('refresh-btn'),
    toast: document.getElementById('toast'),
  };

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2200);
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(v);
  }

  function levelLabel(level) {
    if (level === 'RED') return '红灯预警';
    if (level === 'YELLOW') return '偏重留意';
    return '健康';
  }

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function copyText(text, okMsg = '已复制到剪贴板') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMsg);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast(okMsg);
      } catch {
        showToast('复制失败，请手动选中复制');
      }
      ta.remove();
    }
  }

  function openConversation(convId) {
    if (!convId) return;
    if (window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(convId);
    } else {
      showToast(`会话 ID：${convId.slice(0, 8)}`);
    }
  }

  function renderSparkline(series, cliff, level) {
    if (!Array.isArray(series) || series.length < 2) return '';
    const w = 300;
    const h = 44;
    const maxY = Math.max(cliff, ...series.map((p) => p.tokens || 0));
    const xOf = (i) => (series.length <= 1 ? 0 : (i / (series.length - 1)) * w);
    const yOf = (tok) => h - 3 - Math.min(1, (tok || 0) / maxY) * (h - 7);

    const pts = series.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.tokens).toFixed(1)}`).join(' ');
    const area = `0,${h} ${pts} ${w},${h}`;
    const y75 = yOf(cliff * 0.75).toFixed(1);
    const stroke = level === 'RED' ? 'var(--danger)' : level === 'YELLOW' ? 'var(--warn)' : 'var(--ok)';

    const checkpoints = series
      .map((p, i) =>
        p.checkpoint
          ? `<line x1="${xOf(i).toFixed(1)}" y1="2" x2="${xOf(i).toFixed(1)}" y2="${h}" stroke="var(--accent)" stroke-dasharray="2 2" stroke-width="1"/>`
          : '',
      )
      .join('');

    return `
      <div class="spark-wrap">
        <div class="spark-label">
          <span>近期水位曲线（${series.length} 个采样点）</span>
          <span>虚线 = 75% 预警 / 压缩点</span>
        </div>
        <svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="${y75}" x2="${w}" y2="${y75}" stroke="var(--border-col)" stroke-dasharray="3 3" stroke-width="1"/>
          ${checkpoints}
          <polygon points="${area}" fill="${stroke}" fill-opacity="0.12"/>
          <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>
      </div>
    `;
  }

  function renderHud() {
    const data = state.hud;
    const convId = currentConv();
    if (!convId) {
      els.hudRoot.innerHTML = `<div class="empty-card">请在任意对话中打开此面板，即可实时查看该对话水位。<br><br>也可以切到顶部「轨迹体检」查看过去一周所有主会话的诊断。</div>`;
      return;
    }
    if (!data || !data.exists || !data.report) {
      els.hudRoot.innerHTML = `<div class="empty-card">当前对话（<code>${esc(convId.slice(0, 8))}</code>）尚无轨迹记录，发送第一条消息后将自动刷新。</div>`;
      return;
    }

    const r = data.report;
    const lvl = r.level || 'GREEN';
    const pct = r.fill_percent ?? 0;

    const alertHtml =
      r.reasons && r.reasons.length
        ? `<div class="alert-box level-${esc(lvl)}">
            <strong>${lvl === 'RED' ? '建议切新会话或压缩' : '上下文开始变重'}</strong>
            <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          </div>`
        : '';

    const handoffHtml = state.lastHandoff
      ? `<div class="handoff-box">
          <div>已导出交接包（${fmtTokens(state.lastHandoff.bytes)} B）：</div>
          <div class="mono-path">${esc(state.lastHandoff.path)}</div>
          <div class="actions-row">
            <button class="btn btn-sm" id="copy-handoff-path" type="button">复制路径</button>
            <button class="btn btn-sm" id="copy-handoff-prompt" type="button">复制接手提示词</button>
            ${
              window.sidecar?.agent?.startConversation
                ? '<button class="btn btn-sm btn-primary" id="start-fresh-chat" type="button">开新会话接手</button>'
                : ''
            }
          </div>
        </div>`
      : '';

    const hotFilesHtml = r.hot_files && r.hot_files.length
      ? `<div class="card">
          <div class="sec-head">
            <span class="sec-title">本会话高频修改文件</span>
            <span class="sec-hint">≥ 4 次标返工热点</span>
          </div>
          <div class="list">
            ${r.hot_files
              .map(
                (f) => `<div class="row-item" title="${esc(f.path)}">
                  <div class="row-left">
                    <div class="row-name">${esc(f.name)}</div>
                    <div class="row-path">${esc(f.path)}</div>
                  </div>
                  <span class="pill-count ${f.churn ? 'pill-churn' : ''}">${f.edits} 次${f.churn ? ' · 热点' : ''}</span>
                </div>`,
              )
              .join('')}
          </div>
        </div>`
      : '';

    const failsHtml = `<div class="card">
      <div class="sec-head">
        <span class="sec-title">近期真实命令报错</span>
        <span class="sec-hint">近 40 步 ${r.recent_cmd_failures} 次 / 累计 ${r.total_cmd_failures} 次</span>
      </div>
      ${
        r.recent_failures && r.recent_failures.length
          ? `<div class="list">${r.recent_failures
              .map(
                (f) => `<div class="fail-item">
                  <div class="fail-meta">step #${f.step} · exit ${f.code}${f.at ? ` · ${esc(shortDate(f.at))}` : ''}</div>
                  <div class="fail-snip">${esc(f.snippet)}</div>
                </div>`,
              )
              .join('')}</div>`
          : `<div class="sec-hint">本会话近期无非零命令报错。</div>`
      }
    </div>`;

    els.hudRoot.innerHTML = `
      <div class="card">
        <div class="conv-meta">
          <div class="conv-title" title="${esc(data.title)}">${esc(data.title || convId.slice(0, 8))}</div>
          ${r.latest_model ? `<span class="model-tag">${esc(r.latest_model)}</span>` : ''}
        </div>
        <div class="gauge-head">
          <div class="gauge-pct level-${esc(lvl)}">${pct}%</div>
          <span class="badge level-${esc(lvl)}">● ${levelLabel(lvl)}</span>
        </div>
        <div class="bar-wrap" aria-label="上下文水位 ${pct}%">
          <div class="bar-fill level-${esc(lvl)}" style="width: ${pct}%"></div>
          <div class="bar-tick" style="left: 75%" title="75% 黄灯参考线"></div>
          <div class="bar-tick" style="left: 85%" title="85% 红灯参考线"></div>
        </div>
        <div class="gauge-sub">
          <span>${fmtTokens(r.latest_effective_tokens)} / ${fmtTokens(r.compaction_cliff)} tokens</span>
          <span>峰值 ${fmtTokens(r.peak_effective_tokens)}</span>
        </div>
        ${renderSparkline(r.token_series, r.compaction_cliff, lvl)}
      </div>

      ${alertHtml}

      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi-label">压缩代数</div>
          <div class="kpi-val">G${r.compaction_generation}</div>
          <div class="kpi-sub">${r.compaction_generation === 0 ? '原汁原味' : `已压缩 ${r.compaction_generation} 次`}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">近 40 步报错</div>
          <div class="kpi-val">${r.recent_cmd_failures}</div>
          <div class="kpi-sub">累计 ${r.total_cmd_failures} 次</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">工具密度</div>
          <div class="kpi-val">${r.actions_per_ui}</div>
          <div class="kpi-sub">次/轮 (${r.gen_user_turns} 轮)</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">总步数</div>
          <div class="kpi-val">${r.total_steps}</div>
          <div class="kpi-sub">本代 ${r.gen_steps} 步</div>
        </div>
      </div>

      <div class="card">
        <div class="actions-row">
          <button id="export-handoff-btn" class="btn btn-primary" type="button" ${state.exporting || !data.handoffSupported ? 'disabled' : ''}>
            ${state.exporting ? '正在导出…' : '一键导出干净交接包'}
          </button>
          <button id="copy-hud-summary" class="btn" type="button">复制当前水位</button>
        </div>
        ${handoffHtml}
      </div>

      ${hotFilesHtml}
      ${failsHtml}
    `;

    document.getElementById('export-handoff-btn')?.addEventListener('click', exportHandoff);
    document.getElementById('copy-hud-summary')?.addEventListener('click', () => {
      const text = `[${levelLabel(lvl)}] G${r.compaction_generation} · 水位 ${pct}% (${fmtTokens(r.latest_effective_tokens)}/${fmtTokens(r.compaction_cliff)}) · 近40步报错 ${r.recent_cmd_failures} 次 · 工具密度 ${r.actions_per_ui}/轮`;
      copyText(text, '已复制水位摘要');
    });
    document.getElementById('copy-handoff-path')?.addEventListener('click', () => {
      if (state.lastHandoff?.path) copyText(state.lastHandoff.path, '已复制交接包路径');
    });
    document.getElementById('copy-handoff-prompt')?.addEventListener('click', () => {
      if (state.lastHandoff?.starterPrompt) copyText(state.lastHandoff.starterPrompt, '已复制接手提示词');
    });
    document.getElementById('start-fresh-chat')?.addEventListener('click', async () => {
      if (!state.lastHandoff?.starterPrompt || !window.sidecar?.agent?.startConversation) return;
      try {
        await window.sidecar.agent.startConversation(state.lastHandoff.starterPrompt, `接手：${data.title || convId.slice(0, 8)}`);
        showToast('已发起新会话');
      } catch (err) {
        showToast(`开新会话失败：${err.message || err}`);
      }
    });
  }

  function renderMri() {
    const m = state.mri;
    if (!m) {
      els.mriRoot.innerHTML = `<div class="empty-card">正在扫描本地主会话日志…</div>`;
      return;
    }

    const t = m.totals;
    const filteredFrictions = state.mriCatFilter
      ? m.frictions.filter((f) => f.categoryId === state.mriCatFilter)
      : m.frictions;

    const catsHtml = m.categories
      .map(
        (c) => `<div class="cat-row ${state.mriCatFilter === c.id ? 'selected' : ''}" data-cat="${esc(c.id)}">
          <div class="cat-head">
            <span>${esc(c.label)}</span>
            <strong>${c.count} 次（${c.share}%）</strong>
          </div>
          <div class="cat-bar-bg">
            <div class="cat-bar-fill" style="width: ${Math.max(c.count ? 4 : 0, c.share)}%"></div>
          </div>
        </div>`,
      )
      .join('');

    const quotesHtml = filteredFrictions.length
      ? filteredFrictions
          .slice(0, 20)
          .map(
            (f) => `<div class="quote-card">
              <div class="quote-meta">
                <button class="link-btn" data-open-conv="${esc(f.conversationId)}" type="button" title="跳转到该会话">${esc(f.title)}</button>
                <span class="cat-tag">${esc(f.categoryLabel)} · #${f.step}</span>
              </div>
              <div class="quote-text">${esc(f.quote)}</div>
            </div>`,
          )
          .join('')
      : `<div class="sec-hint">当前筛选条件下未命中明显摩擦原话。</div>`;

    const churnHtml = m.churnHotspots.length
      ? m.churnHotspots
          .map(
            (h) => `<div class="row-item" title="${esc(h.path)}">
              <div class="row-left">
                <div class="row-name">${esc(h.name)}</div>
                <div class="row-path">${esc(h.path)}</div>
              </div>
              <span class="pill-count ${h.maxInSession >= 4 ? 'pill-churn' : ''}">${h.totalEdits} 次 · ${h.sessionCount} 会话</span>
            </div>`,
          )
          .join('')
      : `<div class="sec-hint">该时段暂无编辑 ≥ 3 次的文件热点。</div>`;

    const sessionsHtml = m.sessions.length
      ? m.sessions
          .map(
            (s) => `<div class="sess-row" data-open-conv="${esc(s.conversationId)}" title="点击跳转该会话">
              <span class="dot level-${esc(s.level)}"></span>
              <div class="sess-info">
                <div class="sess-title">${esc(s.title)}</div>
                <div class="sess-stats">G${s.compactionGeneration} · 当前 ${s.fillPercent}% (峰 ${s.peakPercent}%) · ${s.userTurns} 轮 · 报错 ${s.totalCmdFailures} · 摩擦 ${s.frictionCount}</div>
              </div>
              <span class="badge level-${esc(s.level)}">${levelLabel(s.level)}</span>
            </div>`,
          )
          .join('')
      : `<div class="sec-hint">该时间窗内没有主会话记录。</div>`;

    els.mriRoot.innerHTML = `
      <div class="mri-toolbar">
        <div class="seg" role="group" aria-label="时间范围">
          <button class="seg-btn ${state.mriDays === 7 ? 'active' : ''}" data-days="7" type="button">近 7 天</button>
          <button class="seg-btn ${state.mriDays === 30 ? 'active' : ''}" data-days="30" type="button">近 30 天</button>
          <button class="seg-btn ${state.mriDays === 0 ? 'active' : ''}" data-days="0" type="button">全部</button>
        </div>
        <button id="copy-mri-md" class="btn btn-sm" type="button">复制 Markdown 体检报告</button>
      </div>

      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi-label">主会话</div>
          <div class="kpi-val">${t.sessions}</div>
          <div class="kpi-sub">扫描 ${m.elapsedMs}ms</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">黄 / 红灯</div>
          <div class="kpi-val">${t.yellow + t.red}</div>
          <div class="kpi-sub">红 ${t.red} · 黄 ${t.yellow}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">摩擦轮次</div>
          <div class="kpi-val">${t.frictions}</div>
          <div class="kpi-sub">占 ${t.frictionRate}% (${t.userTurns} 轮)</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">真实报错</div>
          <div class="kpi-val">${t.cmdFailures}</div>
          <div class="kpi-sub">非零退出码</div>
        </div>
      </div>

      <div class="card">
        <div class="sec-head">
          <span class="sec-title">摩擦主题分布（点条目筛选原话）</span>
          ${state.mriCatFilter ? '<button id="clear-cat-filter" class="btn btn-sm" type="button">显示全部</button>' : '<span class="sec-hint">离线零侵入诊断</span>'}
        </div>
        <div class="list">${catsHtml}</div>
      </div>

      <div class="card">
        <div class="sec-head">
          <span class="sec-title">近期摩擦原话（${filteredFrictions.length} 条）</span>
          <span class="sec-hint">点击标题直达原会话</span>
        </div>
        <div class="list">${quotesHtml}</div>
      </div>

      <div class="card">
        <div class="sec-head">
          <span class="sec-title">跨会话返工热点文件</span>
          <span class="sec-hint">编辑 ≥ 3 次</span>
        </div>
        <div class="list">${churnHtml}</div>
      </div>

      <div class="card">
        <div class="sec-head">
          <span class="sec-title">主会话健康清单（${m.sessions.length}）</span>
          <span class="sec-hint">已自动过滤子代理</span>
        </div>
        <div class="list">${sessionsHtml}</div>
      </div>
    `;

    els.mriRoot.querySelectorAll('[data-days]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mriDays = Number(btn.getAttribute('data-days'));
        state.mriCatFilter = null;
        fetchMri(false);
      });
    });
    document.getElementById('copy-mri-md')?.addEventListener('click', () => {
      if (state.mri?.markdown) copyText(state.mri.markdown, '已复制 Markdown 体检报告');
    });
    document.getElementById('clear-cat-filter')?.addEventListener('click', () => {
      state.mriCatFilter = null;
      renderMri();
    });
    els.mriRoot.querySelectorAll('[data-cat]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-cat');
        state.mriCatFilter = state.mriCatFilter === id ? null : id;
        renderMri();
      });
    });
    els.mriRoot.querySelectorAll('[data-open-conv]').forEach((el) => {
      el.addEventListener('click', () => openConversation(el.getAttribute('data-open-conv')));
    });
  }

  async function fetchHud() {
    const convId = currentConv();
    if (!convId) {
      state.hud = null;
      renderHud();
      return;
    }
    try {
      const res = await apiFetch(`/api/hud?conversationId=${encodeURIComponent(convId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.hud = await res.json();
      els.liveDot.classList.remove('stale');
      renderHud();
    } catch {
      els.liveDot.classList.add('stale');
    }
  }

  async function fetchMri(forceRefresh = false) {
    try {
      const q = new URLSearchParams({ days: String(state.mriDays) });
      if (forceRefresh) q.set('refresh', '1');
      const res = await apiFetch(`/api/mri?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.mri = await res.json();
      renderMri();
    } catch (err) {
      els.mriRoot.innerHTML = `<div class="empty-card">扫描失败：${esc(err.message || err)}</div>`;
    }
  }

  async function exportHandoff() {
    const convId = currentConv();
    if (!convId || state.exporting) return;
    state.exporting = true;
    renderHud();
    try {
      const res = await apiFetch('/api/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId }),
      });
      const out = await res.json();
      if (!out.ok) {
        showToast(out.error || '导出失败');
      } else {
        state.lastHandoff = out;
        await copyText(out.path, '交接包已导出并复制路径');
      }
    } catch (err) {
      showToast(`导出异常：${err.message || err}`);
    } finally {
      state.exporting = false;
      renderHud();
    }
  }

  function switchTab(next) {
    state.tab = next;
    els.tabs.forEach((btn) => {
      const active = btn.getAttribute('data-tab') === next;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    els.panelHud.classList.toggle('hidden', next !== 'hud');
    els.panelMri.classList.toggle('hidden', next !== 'mri');
    if (next === 'mri' && !state.mri) {
      fetchMri(false);
    } else if (next === 'hud') {
      fetchHud();
    }
  }

  els.tabs.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab'))));
  els.refreshBtn.addEventListener('click', () => {
    if (state.tab === 'hud') fetchHud();
    else fetchMri(true);
    showToast('已刷新');
  });

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (!document.hidden && state.tab === 'hud') fetchHud();
    }, 3000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.tab === 'hud') fetchHud();
  });

  fetchHud();
  startPolling();
})();
