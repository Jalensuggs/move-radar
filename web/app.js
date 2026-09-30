// 异动雷达前端：纯 JS + ECharts。数据全部来自 /api/*，每分钟自动刷新。
// 静态快照模式（GitHub Pages，window.STATIC_SNAPSHOT = true）：没有后端，接口换成 snapshot/*.json，
// 由 `npm run export:site` 从本地数据库导出；AI 设置和现场归因这类需要后端的功能不可用。
const STATIC = window.STATIC_SNAPSHOT === true;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** /api/xxx?... → snapshot/xxx.json（相对路径，放在 github.io/仓库名/ 下也能用）。 */
function snapshotPath(path) {
  const u = new URL(path, "http://x");
  const q = u.searchParams;
  const safe = (v) => String(v ?? "").replace(/[^\w.-]/g, "_");
  switch (u.pathname) {
    case "/api/overview": return "snapshot/overview.json";
    case "/api/hot": return `snapshot/hot-${safe(q.get("topic") || "all")}.json`;
    case "/api/chart": return `snapshot/chart-${safe(q.get("symbol"))}.json`;
    case "/api/move": return `snapshot/move-${safe(q.get("symbol"))}-${safe(q.get("date"))}.json`;
    case "/api/moves": return "snapshot/moves.json";
    default: throw new Error("静态快照不支持这个功能");
  }
}

const api = async (path, init) => {
  const r = await fetch(STATIC ? snapshotPath(path) : path, STATIC ? undefined : init);
  if (!r.ok) {
    // 服务器给的原因（"额度用完了""需要登录"）比状态码有用，带上。
    let detail = "";
    try { detail = (await r.json()).error ?? ""; } catch { /* 不是 JSON */ }
    const err = new Error(detail || `${path} → ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
};

const state = {
  symbol: "NVDA",
  topic: "",
  overview: null,
  chartData: null,
  selected: null, // { symbol, date }
  us: safeGet("colorUS") === "1",
};

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } }

const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
/** "#0f766e" + 0.18 → "rgba(15,118,110,0.18)"（ECharts 的渐变需要具体颜色）。 */
function alpha(hex, a) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const cls = (x) => (x == null ? "" : x >= 0 ? "up" : "down");
const pct = (x, d = 2) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const fmtPrice = (v) => (v == null ? "—" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(2));
function ago(ms) {
  if (!ms) return "—";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
}
const hhmm = (ms) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ── 配色切换（红涨绿跌 / 绿涨红跌）─────────────────────────────────────────────
function applyColors() {
  document.body.classList.toggle("us", state.us);
  // 两个按钮都显示"当前是什么"，点一下切到另一种。
  $("#colorToggle").textContent = state.us ? "配色：绿涨红跌" : "配色：红涨绿跌";
}
// ── 主题（奶白 / 深色）──────────────────────────────────────────────────────
const isDark = () => document.documentElement.dataset.theme === "dark";
function applyTheme() {
  $("#themeToggle").textContent = isDark() ? "主题：深色" : "主题：奶白";
}
$("#themeToggle").addEventListener("click", () => {
  if (isDark()) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = "dark";
  safeSet("theme", isDark() ? "dark" : "light");
  applyTheme();
  // 图表颜色是渲染时从 CSS 变量读的，换主题要重画。
  renderChart();
  if (state.overview) renderFearGreed();
});

$("#colorToggle").addEventListener("click", () => {
  state.us = !state.us;
  safeSet("colorUS", state.us ? "1" : "0");
  applyColors();
  renderTiles();
  renderChart();
  loadMoves();
});

// ── 顶栏状态 ────────────────────────────────────────────────────────────────
function renderChips() {
  const o = state.overview;
  const s = o.stats;
  const chips = [];
  const L = o.llm;
  if (STATIC) {
    chips.push(`<span class="chip warn" title="这是一份只读的数据快照，不会自己更新。本地运行 npm start 才是实时的。">静态快照 · ${esc(new Date(o.static.generatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))} 导出</span>`);
  } else
  // 模型状态：点一下打开设置
  if (L.mode === "llm") chips.push(`<button type="button" class="chip ok clickable" data-open-settings>模型 <b>${esc(L.model)}</b></button>`);
  else if (L.mode === "wait") chips.push(`<button type="button" class="chip clickable" data-open-settings>模型暂停 · ${esc(L.reason)}</button>`);
  else chips.push(`<button type="button" class="chip warn clickable" data-open-settings title="点这里设置 AI">规则模式 · ${esc(L.reason ?? "未接入模型")}</button>`);
  if (L.enabled && !STATIC) {
    const cap = L.saving.dailyCapUsd;
    chips.push(`<span class="chip" title="今天 ${o.cost.calls} 次模型调用">今日 <b class="num">$${o.cost.usd.toFixed(3)}</b>${cap > 0 ? ` / 上限 $${cap}` : ""}</span>`);
    const u = o.usage;
    if (u.llm + u.inherit + u.rules) chips.push(`<span class="chip" title="今天判断的新闻里：调了模型的 / 沿用同一件事已有判断的 / 用规则判断的（没花钱）">模型 <b class="num">${u.llm}</b> · 沿用 <b class="num">${u.inherit}</b> · 规则 <b class="num">${u.rules}</b></span>`);
  }
  chips.push(`<span class="chip">信源 <b class="num">${s.sourcesOk}/${s.sourcesTotal}</b></span>`);
  chips.push(`<span class="chip">24h 新闻 <b class="num">${s.articles24h}</b> · 精选 <b class="num">${s.selected24h}</b></span>`);
  if (s.pending && !STATIC) chips.push(`<span class="chip">待处理 <b class="num">${s.pending}</b></span>`);
  if (!STATIC) chips.push(`<span class="chip">新闻 ${ago(s.lastCollectAt)} · 行情 ${ago(s.marketAt)}</span>`);
  $("#chips").innerHTML = chips.join("");
  for (const el of $("#chips").querySelectorAll("[data-open-settings]")) el.addEventListener("click", openSettings);
  $("#zHint").textContent = o.thresholds.moveZ;
}

// ── AI 设置 ─────────────────────────────────────────────────────────────────
const dlg = $("#settings");
let settingsData = null;

function presetInfo(key) {
  return settingsData?.presets.find((p) => p.key === key);
}

/** 切换服务商：填上这家的默认地址、模型、价格和额外参数；地址只有 OpenAI 兼容的才需要。 */
function applyPreset(key, fromSaved) {
  const p = presetInfo(key);
  const cur = settingsData.current;
  const same = fromSaved && cur.preset === key;
  $("#sPresetHint").textContent = p?.hint ?? "";
  $("#sModelFields").hidden = p?.kind === "off";
  $("#sBaseUrlRow").hidden = p?.kind !== "openai";
  $("#sBaseUrl").value = same ? cur.baseUrl : p?.baseUrl ?? "";
  $("#sModel").value = same ? cur.model : p?.model ?? "";
  const pr = same ? [cur.priceIn, cur.priceOut, cur.priceCached] : p?.price ?? [null, null, null];
  $("#sPriceIn").value = pr[0] ?? "";
  $("#sPriceOut").value = pr[1] ?? "";
  $("#sPriceCached").value = pr[2] ?? "";
  $("#sExtra").value = JSON.stringify(same ? cur.extraBody : p?.extraBody ?? {});
  const saved = same && cur.keySet;
  $("#sKey").value = "";
  $("#sKey").placeholder = saved ? `已保存 ${cur.keyHint}，留空表示不改` : key === "custom" ? "本地模型可以不填" : "粘贴你的 API Key";
  const link = $("#sKeyLink");
  link.hidden = !p?.keyUrl;
  if (p?.keyUrl) link.href = p.keyUrl;
  $("#sModelList").innerHTML = "";
  setStatus("");
}

function setStatus(text, kind = "") {
  const el = $("#sStatus");
  el.textContent = text;
  el.className = `s-status ${kind}`;
}

function formBody() {
  let extra = {};
  const raw = $("#sExtra").value.trim();
  if (raw) {
    try { extra = JSON.parse(raw); } catch { throw new Error("额外请求参数不是合法的 JSON"); }
  }
  return {
    preset: $("#sPreset").value,
    baseUrl: $("#sBaseUrl").value.trim(),
    apiKey: $("#sKey").value.trim(),
    model: $("#sModel").value.trim(),
    priceIn: $("#sPriceIn").value, priceOut: $("#sPriceOut").value, priceCached: $("#sPriceCached").value,
    extraBody: extra,
    saving: {
      onDemand: $("#sOnDemand").checked, idleMinutes: $("#sIdle").value, catchUpHours: $("#sCatchUp").value,
      inherit: $("#sInherit").checked, rescore: $("#sRescore").checked, dailyCapUsd: $("#sCap").value,
    },
  };
}

/** 需要管理员：有密码就弹登录框，没设密码就把原因告诉他。 */
function askLogin(message) {
  const d = $("#login");
  $("#loginPassword").hidden = !message.login;
  $("#loginSubmit").hidden = !message.login;
  $("#loginText").textContent = message.text;
  $("#loginError").textContent = "";
  $("#loginPassword").value = "";
  if (!d.open) d.showModal();
  if (message.login) $("#loginPassword").focus();
}

$("#loginCancel").addEventListener("click", () => $("#login").close());
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginSubmit");
  btn.disabled = true;
  try {
    await postSettings("/api/login", { password: $("#loginPassword").value });
    $("#login").close();
    await openSettings();
  } catch (err) {
    $("#loginError").textContent = err.message;
    $("#loginPassword").select();
  } finally {
    btn.disabled = false;
  }
});

async function openSettings() {
  try {
    settingsData = await api("/api/settings");
  } catch (e) {
    if (e.status === 401) return askLogin({ login: true, text: "改 AI 设置需要管理员密码。" });
    if (e.status === 403) return askLogin({ login: false, text: e.message });
    throw e;
  }
  $("#sPreset").innerHTML = settingsData.presets.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join("");
  $("#sPreset").value = settingsData.current.preset;
  applyPreset(settingsData.current.preset, true);
  const s = settingsData.saving;
  $("#sOnDemand").checked = s.onDemand;
  $("#sIdle").value = s.idleMinutes;
  $("#sCatchUp").value = s.catchUpHours;
  $("#sInherit").checked = s.inherit;
  $("#sRescore").checked = s.rescore;
  $("#sCap").value = s.dailyCapUsd;
  if (settingsData.source === "env") setStatus("当前配置来自 .env；在这里保存后以这里为准。");
  dlg.showModal();
}

async function postSettings(path, body) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

$("#settingsOpen").addEventListener("click", openSettings);
$("#settingsClose").addEventListener("click", () => dlg.close());
$("#sPreset").addEventListener("change", (e) => applyPreset(e.target.value, true));

$("#sListModels").addEventListener("click", async () => {
  const btn = $("#sListModels");
  btn.disabled = true;
  setStatus("正在获取模型列表…");
  try {
    const { models, error } = await postSettings("/api/settings/models", formBody());
    if (error) throw new Error(error);
    $("#sModelList").innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join("");
    setStatus(models.length ? `找到 ${models.length} 个模型，点模型输入框选择` : "没有返回任何模型", models.length ? "ok" : "err");
    if (models.length) $("#sModel").focus();
  } catch (e) {
    setStatus(`获取失败：${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

$("#sTest").addEventListener("click", async () => {
  const btn = $("#sTest");
  btn.disabled = true;
  setStatus("正在测试…");
  try {
    const r = await postSettings("/api/settings/test", formBody());
    setStatus(r.ok ? `${r.message}（${r.ms} ms）` : `失败：${r.message}`, r.ok ? "ok" : "err");
  } catch (e) {
    setStatus(`失败：${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#sSave");
  btn.disabled = true;
  try {
    const r = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(formBody()) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? r.status);
    settingsData = data;
    dlg.close();
    await refreshOverview();
  } catch (err) {
    setStatus(`保存失败：${err.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

// ── 行情卡片 ────────────────────────────────────────────────────────────────
/**
 * 近 30 个交易日的小走势图。用中性色：卡片上的百分比是"当天"涨跌，走势图是"30 天"，
 * 两者方向经常相反（今天跌、30 天涨），都上红绿色就会在同一张卡片上互相打架。
 */
function spark(values) {
  if (!values || values.length < 2) return "";
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${24 - ((v - min) / (max - min || 1)) * 22 - 1}`).join(" ");
  return `<svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--text-3)" stroke-width="1.3" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderTiles() {
  const o = state.overview;
  if (!o) return;
  // 每组一行；现货价格（不可点、只看水平）并进"能源与避险"那一行。
  const rows = [
    ["market", o.tiles.filter((t) => t.group === "market")],
    ["semis", o.tiles.filter((t) => t.group === "semis")],
    ["ai", o.tiles.filter((t) => t.group === "ai")],
    ["energy", o.tiles.filter((t) => t.group === "energy" || t.group === "level")],
  ];
  let html = "";
  for (const [g, tiles] of rows) {
    if (!tiles.length) continue;
    html += `<div class="tile-label">${esc(o.groups[g])}</div>`;
    for (const t of tiles) {
      const level = t.group === "level";
      const tag = level ? "div" : "button";
      // 右上角：可点的标的显示代码；现货显示数据日期（FRED 有发布延迟）。
      const corner = level ? (t.date ?? "").slice(5) : t.symbol;
      const tip = [t.name, t.note, level ? "FRED 官方现货价，发布有延迟" : null, t.date && `数据日期 ${t.date}`, "小图：近 30 个交易日走势"].filter(Boolean).join(" · ");
      html += `<${tag} class="tile${level ? " static" : ""}${t.symbol === state.symbol ? " active" : ""}" data-symbol="${esc(t.symbol)}" title="${esc(tip)}"${level ? "" : ' type="button"'}>
        <div class="name"><span>${esc(t.name)}</span><small>${esc(corner)}</small></div>
        <div class="row"><span class="price">${fmtPrice(t.close)}</span><span class="chg ${cls(t.change)}">${pct(t.change)}</span></div>
        ${spark(t.spark)}
      </${tag}>`;
    }
  }
  $("#tiles").innerHTML = html;
  for (const el of document.querySelectorAll("button.tile")) el.addEventListener("click", () => selectSymbol(el.dataset.symbol));
}

// ── 标的切换 ────────────────────────────────────────────────────────────────
function renderSymbolTabs() {
  const tiles = state.overview.tiles.filter((t) => t.group !== "level");
  $("#symbolTabs").innerHTML = tiles.map((t) => `<button class="tab" role="tab" type="button" aria-selected="${t.symbol === state.symbol}" data-symbol="${esc(t.symbol)}">${esc(t.symbol)}</button>`).join("");
  for (const el of $("#symbolTabs").querySelectorAll(".tab")) el.addEventListener("click", () => selectSymbol(el.dataset.symbol));
}

async function selectSymbol(symbol) {
  state.symbol = symbol;
  safeSet("symbol", symbol);
  renderTiles();
  renderSymbolTabs();
  await loadChart();
  const last = state.chartData?.moves.filter((m) => !m.forced).at(-1);
  if (last) showMove(symbol, last.date);
}

// ── 走势图 ──────────────────────────────────────────────────────────────────
const chart = echarts.init($("#chart"), null, { renderer: "canvas" });
window.addEventListener("resize", () => { chart.resize(); gauge.resize(); });

async function loadChart() {
  state.chartData = await api(`/api/chart?symbol=${encodeURIComponent(state.symbol)}`);
  renderChart();
}

function renderChart() {
  const d = state.chartData;
  if (!d) return;
  const { asset, series, moves } = d;
  const last = series.at(-1), prev = series.at(-2);
  const chg = last && prev ? last.close / prev.close - 1 : null;
  $("#chartMeta").innerHTML = `<span class="title">${esc(asset.name)} <span class="muted num">${esc(asset.symbol)}</span></span>
    <span class="num" style="font-size:18px">${fmtPrice(last?.close)}</span><span class="num ${cls(chg)}">${pct(chg)}</span>
    <span class="note">${esc(asset.note ?? "")} ${last ? `· ${esc(last.date)}` : ""} · 两年内异动 ${moves.filter((m) => !m.forced).length} 次</span>`;

  const up = css("--up"), down = css("--down"), grid = css("--line"), text = css("--text-3");
  const accent = css("--accent"), panel = css("--panel"), ink = css("--text"), line = css("--chart-line");
  const dates = series.map((p) => p.date);
  const idx = new Map(dates.map((x, i) => [x, i]));
  const points = moves.filter((m) => idx.has(m.date) && !m.forced).map((m) => ({
    value: [m.date, series[idx.get(m.date)].close],
    move: m,
    symbol: "triangle",
    symbolRotate: m.ret >= 0 ? 0 : 180,
    symbolSize: Math.min(22, 8 + Math.abs(m.z) * 2),
    itemStyle: { color: m.ret >= 0 ? up : down, borderColor: panel, borderWidth: 1 },
  }));
  chart.setOption({
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 56, right: 16, top: 16, bottom: 56 },
    tooltip: {
      trigger: "axis",
      backgroundColor: panel, borderColor: grid, textStyle: { color: ink, fontSize: 12 },
      formatter: (ps) => {
        const p = ps.find((x) => x.seriesIndex === 0) ?? ps[0];
        const i = p.dataIndex;
        const r = i > 0 ? series[i].close / series[i - 1].close - 1 : null;
        const m = moves.find((x) => x.date === series[i].date && !x.forced);
        return `${series[i].date}<br><b>${fmtPrice(series[i].close)}</b> <span style="color:${r >= 0 ? up : down}">${pct(r)}</span>` +
          (m ? `<br>异动 z=${m.z.toFixed(1)}${m.primary ? `<br><span style="color:#9aa6b5">${esc(m.primary.title).slice(0, 40)}</span>` : ""}` : "");
      },
    },
    xAxis: { type: "category", data: dates, boundaryGap: false, axisLine: { lineStyle: { color: grid } }, axisLabel: { color: text } },
    yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: grid } }, axisLabel: { color: text } },
    dataZoom: [
      { type: "inside", startValue: Math.max(0, dates.length - 260) },
      { type: "slider", startValue: Math.max(0, dates.length - 260), height: 22, bottom: 8, borderColor: grid, textStyle: { color: text }, fillerColor: alpha(accent, 0.1), dataBackground: { lineStyle: { color: grid }, areaStyle: { color: grid } } },
    ],
    series: [
      {
        type: "line", data: series.map((p) => p.close), showSymbol: false, lineStyle: { width: 1.6, color: line },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(accent, 0.18) }, { offset: 1, color: alpha(accent, 0) }]) },
      },
      { type: "scatter", data: points, z: 3, cursor: "pointer" },
    ],
  }, true);
}

chart.on("click", (p) => {
  if (p.seriesIndex === 1 && p.data?.move) showMove(state.symbol, p.data.move.date);
});
// 点图上任意一天：看那天有没有异动，没有也可以要求归因。
chart.getZr().on("click", (e) => {
  if (e.target) return;
  const d = state.chartData;
  if (!d) return;
  const pt = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]);
  const i = Math.round(pt?.[0]);
  if (Number.isFinite(i) && d.series[i]) showMove(state.symbol, d.series[i].date);
});

// ── 归因面板 ────────────────────────────────────────────────────────────────
const CONF = { high: "高置信", medium: "中置信", low: "低置信" };
const CTX_NAMES = { SPX: "标普", COMP: "纳指", SOX: "半导体", VIX: "VIX", USO: "原油", GLD: "黄金" };

async function showMove(symbol, date) {
  state.selected = { symbol, date };
  const box = $("#attribution");
  box.innerHTML = `<p class="skeleton">读取 ${esc(symbol)} ${esc(date)}…</p>`;
  let data = null;
  try {
    data = await api(`/api/move?symbol=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}`);
  } catch { /* 这天不是异动 */ }
  if (state.selected?.date !== date || state.selected?.symbol !== symbol) return;
  if (!data?.attribution) {
    const s = state.chartData?.series ?? [];
    const i = s.findIndex((p) => p.date === date);
    const r = i > 0 ? s[i].close / s[i - 1].close - 1 : null;
    // 静态快照里没预先归因的异动没有单独的文件，从走势数据里找。
    const m = data?.move ?? (STATIC ? state.chartData?.moves.find((x) => x.date === date && !x.forced) : null);
    box.innerHTML = `<div class="head"><div><div>${esc(state.chartData?.asset.name ?? symbol)} · ${esc(date)}</div>
        <div class="sub">${m ? `异动 z=${m.z.toFixed(1)}，还没归因` : "未达异动阈值"}</div></div>
        <span class="big ${cls(m?.ret ?? r)}">${pct(m?.ret ?? r)}</span></div>
      ${STATIC
        ? '<p class="muted" style="font-size:12px">这一天没有预先归因。静态快照只带了已经归因过的异动；本地运行 <code>npm start</code> 可以现场归因任意一天。</p>'
        : `<button class="btn" id="attrBtn" type="button">归因这一天</button>
      <p class="muted" style="font-size:12px">会去 Google News 回溯当天新闻，判断后再归因，大约 10-60 秒。</p>`}`;
    if (!STATIC) $("#attrBtn").addEventListener("click", () => runAttribution(symbol, date));
    return;
  }
  renderAttribution(data.move, data.attribution);
}

async function runAttribution(symbol, date) {
  const btn = $("#attrBtn");
  btn.disabled = true;
  btn.textContent = "回溯新闻并归因中…";
  try {
    const data = await api("/api/attribute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, date }) });
    if (state.selected?.date === date) renderAttribution(data.move, data.attribution);
    loadChart();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = `失败了，再试一次（${e.message}）`;
  }
}

function renderAttribution(m, a) {
  const cand = (c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a> <small>${esc(c.publisher ?? "")}${c.publishers > 1 ? ` · ${c.publishers} 家` : ""}</small>`;
  const ctx = Object.entries(a.context).filter(([k]) => k !== m.symbol && CTX_NAMES[k]);
  $("#attribution").innerHTML = `
    <div class="head"><div><div>${esc(m.name)} · ${esc(m.date)}</div><div class="sub">z = ${m.z.toFixed(1)} · 收盘 ${fmtPrice(m.close)} · ${a.newsCount} 条相关新闻 · ${a.mode === "llm" ? "模型归因" : "规则归因"}</div></div>
      <span class="big ${cls(m.ret)}">${pct(m.ret)}</span></div>
    <div class="explain">${esc(a.explanation)}<span class="conf">${CONF[a.confidence] ?? ""}</span></div>
    ${a.primary ? `<a class="primary" href="${esc(a.primary.url)}" target="_blank" rel="noopener"><div class="lbl">主因</div>${esc(a.primary.title)}<div class="sub">${esc(a.primary.publisher ?? "")} · ${hhmm(a.primary.at)}</div></a>` : ""}
    <div class="section-label">同日大盘</div>
    <div class="ctx">${ctx.map(([k, v]) => `<div>${CTX_NAMES[k]}<b class="${cls(v)}">${pct(v)}</b></div>`).join("")}</div>
    <div class="section-label">候选事件（按相关度）</div>
    <ul class="cands">${a.candidates.slice(0, 8).map((c) => `<li><span class="s">${c.score}${c.direct ? "·直" : ""}</span><span>${cand(c)}</span></li>`).join("") || '<li class="muted">没有候选</li>'}</ul>`;
}

// ── 恐慌与贪婪 ──────────────────────────────────────────────────────────────
const gauge = echarts.init($("#gauge"));
const FG_LABEL = { "extreme fear": "极度恐慌", fear: "恐慌", neutral: "中性", greed: "贪婪", "extreme greed": "极度贪婪" };

function renderFearGreed() {
  const fg = state.overview.fearGreed.cnn;
  if (!fg) {
    $("#fgMeta").innerHTML = '<span class="muted">暂时取不到 CNN 数据</span>';
    return;
  }
  gauge.setOption({
    series: [{
      type: "gauge", startAngle: 200, endAngle: -20, min: 0, max: 100, radius: "92%", center: ["50%", "56%"],
      axisLine: { lineStyle: { width: 14, color: [[0.25, "#f0506e"], [0.45, "#f59e0b"], [0.55, "#9aa6b5"], [0.75, "#84cc16"], [1, "#22c55e"]] } },
      pointer: { length: "52%", width: 5, offsetCenter: [0, 0], itemStyle: { color: css("--text") } },
      axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { color: css("--text-3"), distance: -34, fontSize: 10, formatter: (v) => ([0, 25, 50, 75, 100].includes(v) ? v : "") },
      detail: { valueAnimation: true, formatter: (v) => `{v|${Math.round(v)}}\n{l|${FG_LABEL[fg.rating] ?? fg.rating}}`, offsetCenter: [0, "42%"],
        rich: { v: { fontSize: 30, fontWeight: 700, color: css("--text"), fontFamily: "ui-monospace, Menlo" }, l: { fontSize: 12, color: css("--text-2"), padding: [4, 0, 0, 0] } } },
      data: [{ value: fg.score }],
    }],
  });
  const cell = (label, v) => `<div>${label}<b>${v == null ? "—" : Math.round(v)}</b></div>`;
  $("#fgMeta").innerHTML = cell("昨收", fg.previousClose) + cell("一周前", fg.previousWeek) + cell("一月前", fg.previousMonth) + cell("一年前", fg.previousYear);
  $("#fgComponents").innerHTML = (fg.components ?? []).filter((c) => c.score != null).map((c) =>
    `<li><span>${esc(c.name)}</span><span class="track" title="${esc(FG_LABEL[c.rating] ?? c.rating ?? "")}"><i style="left:calc(${c.score}% - 1px)"></i></span><span class="v">${Math.round(c.score)}</span></li>`).join("");
}

// ── 热点 ────────────────────────────────────────────────────────────────────
function renderTopicTabs() {
  const topics = [{ key: "", name: "全部" }, ...state.overview.topics];
  $("#topicTabs").innerHTML = topics.map((t) => `<button class="tab" role="tab" type="button" aria-selected="${t.key === state.topic}" data-topic="${t.key}">${esc(t.name)}</button>`).join("");
  for (const el of $("#topicTabs").querySelectorAll(".tab")) el.addEventListener("click", () => { state.topic = el.dataset.topic; renderTopicTabs(); loadHot(); });
}

async function loadHot() {
  const { events } = await api(`/api/hot?limit=15${state.topic ? `&topic=${state.topic}` : ""}`);
  const topicName = Object.fromEntries(state.overview.topics.map((t) => [t.key, t.name]));
  const max = Math.max(1, ...events.map((e) => e.heat));
  $("#hot").innerHTML = events.map((e) => `<li>
      <div class="hot-row">
        <div><div class="hot-title">${esc(e.title)}</div>
          <div class="hot-meta"><span class="tag">${esc(topicName[e.topic] ?? e.topic)}</span>
            ${e.isNew ? '<span class="tag new">新</span>' : e.rising ? '<span class="tag rising">↑ 升温</span>' : ""}
            <span>${e.publishers} 家报道</span><span>${ago(e.latestAt)}</span><span>重要度 ${e.bestImportance}</span></div></div>
        <div class="heat"><div class="v">${e.heat.toFixed(1)}</div><div class="bar"><i style="width:${(e.heat / max) * 100}%"></i></div></div>
      </div>
      <ul class="hot-articles">${e.articles.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a><small>${esc(a.publisher ?? "")} · ${ago(a.at)}</small>${a.summary ? `<span class="sum">${esc(a.summary)}</span>` : ""}</li>`).join("")}</ul>
    </li>`).join("") || '<li class="skeleton">还没有热点，第一轮采集需要一两分钟。</li>';
  for (const li of $("#hot").children) li.querySelector(".hot-row")?.addEventListener("click", () => li.classList.toggle("open"));
}

// ── 最近异动 ────────────────────────────────────────────────────────────────
async function loadMoves() {
  const { moves } = await api("/api/moves?days=30");
  $("#moves").innerHTML = moves.map((m) => `<li data-symbol="${esc(m.symbol)}" data-date="${esc(m.date)}">
      <span class="d">${esc(m.date.slice(5))}</span>
      <span class="s"><b>${esc(m.name)}</b><span class="${cls(m.ret)}">${pct(m.ret, 1)}</span></span>
      <span class="why">${m.primary ? esc(m.primary.title) : m.attributed ? '<span class="muted">没有找到明确新闻</span>' : '<span class="muted">待归因</span>'}</span>
    </li>`).join("") || '<li class="muted">最近 30 天没有异动</li>';
  for (const li of $("#moves").children) {
    li.addEventListener("click", async () => {
      if (li.dataset.symbol !== state.symbol) await selectSymbol(li.dataset.symbol);
      showMove(li.dataset.symbol, li.dataset.date);
      $("#attrCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}

// ── 启动与刷新 ──────────────────────────────────────────────────────────────
async function refreshOverview() {
  state.overview = await api("/api/overview");
  renderChips();
  renderTiles();
  renderFearGreed();
}

async function boot() {
  applyTheme();
  applyColors();
  if (STATIC) $("#settingsOpen").hidden = true;
  state.symbol = safeGet("symbol") || state.symbol;
  await refreshOverview();
  if (!state.overview.tiles.some((t) => t.symbol === state.symbol && t.group !== "level")) state.symbol = "NVDA";
  renderSymbolTabs();
  renderTopicTabs();
  await Promise.all([selectSymbol(state.symbol), loadHot(), loadMoves()]);
  if (STATIC) return; // 快照不会变，不用轮询
  // 只在页面可见时刷新：后台标签页不刷新，服务端就知道"没人在看"，可以暂停模型省钱。
  const visible = () => document.visibilityState === "visible";
  setInterval(() => { if (visible()) refreshOverview().catch(() => {}); }, 60_000);
  setInterval(() => { if (visible()) loadHot().catch(() => {}); }, 60_000);
  setInterval(() => { if (visible()) { loadMoves().catch(() => {}); loadChart().catch(() => {}); } }, 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (visible()) Promise.all([refreshOverview(), loadHot()]).catch(() => {});
  });
}

boot().catch((e) => {
  document.querySelector("main").insertAdjacentHTML("afterbegin", `<p class="card">加载失败：${esc(e.message)}</p>`);
});
