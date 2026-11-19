const DATA_URL = "./data/snapshots.json";
// 공식 출시일(웹). 이보다 먼저 등록된 방은 베타 기간 메시지가 섞일 수 있어 하루 평균은 이 날짜부터 계산한다.
const LAUNCH = new Date("2026-10-19T00:00:00+09:00");
const DAY_MS = 86400000;
const METRICS = [
  { key: "msg", field: "message_count", label: "메시지", cls: "msg" },
  { key: "like", field: "like_count", label: "좋아요", cls: "like" },
];
const number = new Intl.NumberFormat("ko-KR");
const decimal = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const dateLabel = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" });
const fullDate = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "2-digit", day: "2-digit", timeZone: "Asia/Seoul" });

const fmt = (value) => (Number.isFinite(value) ? number.format(Math.round(value)) : "—");
const signed = (value) => (Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${fmt(value)}` : "—");
const compact = (value) => {
  const abs = Math.abs(value);
  if (abs >= 10000) return `${decimal.format(value / 10000)}만`;
  if (abs >= 1000) return `${decimal.format(value / 1000)}천`;
  return fmt(value);
};
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dateOf = (snapshot) => new Date(snapshot.captured_at);
const dayKey = (date) => date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

let history = null;
let modelMode = "share";
let sortState = { key: "rank", dir: 1 };

/* ---------- data model ---------- */

function totals(snapshot) {
  if (snapshot?.totals && Number.isFinite(snapshot.totals.message_count)) return snapshot.totals;
  const items = snapshot?.items || [];
  return {
    message_count: items.reduce((sum, item) => sum + (item.message_count || 0), 0),
    like_count: items.reduce((sum, item) => sum + (item.like_count || 0), 0),
    observed_items: items.length,
  };
}

// 하루에 하나(그날 마지막 수집)만 남긴다.
function dailySnapshots(snapshots) {
  const days = new Map();
  (snapshots || []).filter((s) => s.items?.length).forEach((s) => days.set(dayKey(dateOf(s)), s));
  return [...days.values()].sort((a, b) => dateOf(a) - dateOf(b));
}

function growth(current, previous) {
  if (!current || !previous) return null;
  const a = totals(current), b = totals(previous);
  return { msg: a.message_count - b.message_count, like: a.like_count - b.like_count };
}

// 기간 순증 = 그 기간 마지막 수집값 − 직전 기간 마지막 수집값(없으면 그 기간 첫 수집값)
function periodGrowth(daily, period) {
  const groups = new Map();
  daily.forEach((snapshot) => {
    const p = period(dateOf(snapshot));
    if (!groups.has(p.key)) groups.set(p.key, { ...p, values: [] });
    groups.get(p.key).values.push(snapshot);
  });
  const ordered = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  return ordered.map((group, index) => {
    const base = index ? ordered[index - 1].values.at(-1) : group.values[0];
    const end = group.values.at(-1);
    if (base === end) return null;
    return { key: group.key, label: group.label, growth: growth(end, base) };
  }).filter(Boolean);
}

function weekPeriod(date) {
  const [y, m, d] = dayKey(date).split("-").map(Number);
  const monday = new Date(Date.UTC(y, m - 1, d));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { key: monday.toISOString().slice(0, 10), label: `${monday.getUTCMonth() + 1}/${monday.getUTCDate()}주` };
}

function monthPeriod(date) {
  const key = dayKey(date).slice(0, 7);
  return { key, label: `${Number(key.slice(5))}월` };
}

function activeDays(item, at) {
  const created = item.created_at ? new Date(item.created_at) : LAUNCH;
  const start = created > LAUNCH ? created : LAUNCH;
  return Math.max(1, (at - start) / DAY_MS);
}

function rows(latest, previous) {
  const prior = new Map((previous?.items || []).map((item) => [item.key, item]));
  const gapDays = previous ? Math.max(1, (dateOf(latest) - dateOf(previous)) / DAY_MS) : null;
  const total = totals(latest).message_count || 1;
  return latest.items.map((item) => {
    const p = prior.get(item.key);
    const msgDelta = p ? item.message_count - p.message_count : null;
    return {
      ...item,
      msgDelta,
      likeDelta: p ? item.like_count - p.like_count : null,
      recentPerDay: msgDelta === null ? null : msgDelta / gapDays,
      perDay: item.message_count / activeDays(item, dateOf(latest)),
      share: item.message_count / total,
      likeRate: item.message_count ? (item.like_count / item.message_count) * 1000 : null,
      created: item.created_at ? new Date(item.created_at).getTime() : null,
    };
  });
}

/* ---------- charts (plain SVG) ---------- */

// 막대: 기준선에서 시작, 데이터 끝만 4px 둥글게
function barPath(x, base, end, w) {
  const h = Math.abs(base - end);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return `M${x},${base}h${w}`;
  if (end < base) return `M${x},${base}V${end + r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + r}V${base}Z`;
  return `M${x},${base}V${end - r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end - r}V${base}Z`;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function showLabel(i, n) {
  return n <= 10 || i === 0 || i === n - 1 || i === Math.floor(n / 2);
}

function barChart(entries, metric) {
  const W = 560, H = 210, L = 46, R = 8, T = 18, B = 30;
  const values = entries.map((e) => e.growth[metric.key]);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0], hi = ticks.at(-1);
  const y = (v) => T + ((hi - v) / (hi - lo || 1)) * (H - T - B);
  const slot = (W - L - R) / entries.length;
  const bw = Math.max(3, Math.min(28, slot - 2));
  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${metric.label} 순증 막대그래프">`;
  ticks.forEach((t) => { svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`; });
  svg += `<line class="base-line" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  const maxIndex = values.indexOf(Math.max(...values));
  entries.forEach((e, i) => {
    const v = values[i], x = L + i * slot + (slot - bw) / 2;
    const tip = `<b>${esc(e.label)}</b>${metric.label} ${signed(v)}`;
    svg += `<path class="fill-${metric.cls}" d="${barPath(x, y(0), y(v), bw)}"/>`;
    svg += `<rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" data-tip="${esc(tip)}"/>`;
    if (entries.length <= 8 || i === entries.length - 1 || i === maxIndex) {
      const isLastCrowded = entries.length > 8 && i === entries.length - 1;
      svg += `<text class="value-label" text-anchor="${isLastCrowded ? "end" : "middle"}" x="${isLastCrowded ? x + bw : x + bw / 2}" y="${v >= 0 ? y(v) - 5 : y(v) + 13}">${signed(v)}</text>`;
    }
    if (showLabel(i, entries.length)) svg += `<text class="axis-label" text-anchor="middle" x="${x + bw / 2}" y="${H - 9}">${esc(e.label)}</text>`;
  });
  return `${svg}</svg>`;
}

function lineChart(entries, metric) {
  const W = 560, H = 220, L = 52, R = 14, T = 20, B = 30;
  const values = entries.map((e) => e.value);
  const pad = (Math.max(...values) - Math.min(...values)) * 0.15 || Math.max(...values) * 0.05 || 1;
  const ticks = niceTicks(Math.max(0, Math.min(...values) - pad), Math.max(...values) + pad);
  const lo = ticks[0], hi = ticks.at(-1);
  const y = (v) => T + ((hi - v) / (hi - lo || 1)) * (H - T - B);
  const x = (i) => (entries.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (entries.length - 1));
  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${metric.label} 누적 꺾은선그래프">`;
  ticks.forEach((t) => { svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`; });
  if (entries.length > 1) svg += `<polyline class="line stroke-${metric.cls}" points="${entries.map((e, i) => `${x(i)},${y(e.value)}`).join(" ")}"/>`;
  const colW = entries.length === 1 ? 60 : (W - L - R) / (entries.length - 1);
  entries.forEach((e, i) => {
    const tip = `<b>${esc(e.label)}</b>${metric.label} 누적 ${fmt(e.value)}${e.delta !== null ? `<br>전일 대비 ${signed(e.delta)}` : ""}`;
    svg += `<rect class="hit" x="${x(i) - colW / 2}" y="${T}" width="${colW}" height="${H - T - B}" data-tip="${esc(tip)}"/>`;
    svg += `<line class="hover-guide" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}"/>`;
    svg += `<circle class="point fill-${metric.cls}" cx="${x(i)}" cy="${y(e.value)}" r="4"/>`;
    if (showLabel(i, entries.length)) svg += `<text class="axis-label" text-anchor="middle" x="${x(i)}" y="${H - 9}">${esc(e.label)}</text>`;
  });
  const last = entries.at(-1);
  svg += `<text class="value-label" text-anchor="end" x="${x(entries.length - 1) - 8}" y="${Math.max(12, y(last.value) - 10)}">${fmt(last.value)}</text>`;
  return `${svg}</svg>`;
}

function chartBlock(metric, inner, latestText = "") {
  return `<div class="chart-block"><p class="chart-title"><i class="swatch-${metric.cls}"></i>${metric.label}${latestText ? `<span class="latest">${latestText}</span>` : ""}</p>${inner}</div>`;
}

function renderGrowthPair(rootId, entries, emptyText) {
  const root = document.getElementById(rootId);
  root.innerHTML = METRICS.map((metric) => chartBlock(metric, entries.length
    ? barChart(entries, metric)
    : `<p class="empty-chart">${emptyText}</p>`)).join("");
}

function renderAbsolutePair(daily) {
  const root = document.getElementById("absolute-chart");
  const tail = daily.slice(-30);
  root.innerHTML = METRICS.map((metric) => {
    const entries = tail.map((s, i) => {
      const value = totals(s)[metric.field];
      const prev = i ? totals(tail[i - 1])[metric.field] : null;
      return { label: dateLabel.format(dateOf(s)), value, delta: prev === null ? null : value - prev };
    });
    return chartBlock(metric, lineChart(entries, metric), `현재 ${fmt(entries.at(-1).value)}`);
  }).join("");
}

/* ---------- model panel ---------- */

const MODEL_COPY = {
  share: "전체 공개 메시지 중 각 작품이 차지하는 비중. 상위 3개 작품이 얼마나 쏠려 있는지 바로 보입니다.",
  rate: "누적 메시지 ÷ 활성 일수. 공식 출시일(2026-10-19) 이전에 등록된 방은 출시일부터 셉니다. 베타 기간 메시지가 섞여 있어 초기 작품은 다소 높게 나올 수 있는 추정치입니다.",
  recent: "직전 수집 대비 메시지 순증을 하루 기준으로 환산한 값. 지금 실제로 대화가 붙고 있는 작품을 보여줍니다.",
};

function renderModel(rowsData, hasPrevious) {
  document.getElementById("model-note").textContent = MODEL_COPY[modelMode];
  const root = document.getElementById("model-chart");
  if (modelMode === "recent" && !hasPrevious) {
    root.innerHTML = '<p class="empty-chart">서로 다른 날짜에 두 번 수집되면(다음 07:00 KST 수집 이후) 표시됩니다.</p>';
    return;
  }
  const pick = {
    share: (r) => ({ v: r.share, text: `${decimal.format(r.share * 100)}%`, sub: `${fmt(r.message_count)}건` }),
    rate: (r) => ({ v: r.perDay, text: `${fmt(r.perDay)}/일`, sub: `누적 ${fmt(r.message_count)}` }),
    recent: (r) => ({ v: r.recentPerDay ?? 0, text: `${signed(r.recentPerDay)}/일`, sub: `증감 ${signed(r.msgDelta)}` }),
  }[modelMode];
  const list = rowsData.map((r) => ({ r, ...pick(r) })).sort((a, b) => b.v - a.v);
  const max = Math.max(...list.map((e) => Math.abs(e.v)), 1e-9);
  root.innerHTML = list.map(({ r, v, text, sub }) => `
    <div class="hbar" data-tip="${esc(`<b>${esc(r.name)}</b>${text} · ${sub}${r.tags?.length ? `<br>${esc(r.tags.join(" · "))}` : ""}`)}">
      <span class="hbar-name">${esc(r.name)}</span>
      <span class="hbar-track"><span class="hbar-fill${v < 0 ? " neg" : ""}" style="width:${(Math.abs(v) / max) * 100}%"></span></span>
      <span class="hbar-value">${text}<small>${sub}</small></span>
    </div>`).join("");
}

/* ---------- table ---------- */

function renderTable(rowsData) {
  const keyword = document.getElementById("search").value.trim().toLocaleLowerCase("ko-KR");
  const delta = (v) => (v === null ? "—" : `<span class="delta ${v < 0 ? "negative" : v === 0 ? "zero" : ""}">${signed(v)}</span>`);
  const { key, dir } = sortState;
  const sorted = rowsData
    .filter((r) => [r.name, ...(r.tags || []), ...(r.members || [])].join(" ").toLocaleLowerCase("ko-KR").includes(keyword))
    .sort((a, b) => ((a[key] ?? -Infinity) > (b[key] ?? -Infinity) ? 1 : (a[key] ?? -Infinity) < (b[key] ?? -Infinity) ? -1 : 0) * dir);
  document.querySelectorAll("#ranking-head th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    th.classList.toggle("asc", th.dataset.sort === key && dir === 1 && key !== "rank");
  });
  document.getElementById("ranking-body").innerHTML = sorted.map((r) => `<tr>
      <td>${r.rank ?? "—"}</td>
      <td class="name-cell"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.name)}</a><span class="tags">${esc((r.tags || []).join(" · "))}</span></td>
      <td class="num">${fmt(r.message_count)}</td>
      <td class="num">${fmt(r.like_count)}</td>
      <td class="num">${delta(r.msgDelta)}</td>
      <td class="num">${delta(r.likeDelta)}</td>
      <td class="num">${fmt(r.perDay)}</td>
      <td class="num">${r.likeRate === null ? "—" : decimal.format(r.likeRate)}</td>
      <td class="num">${r.created ? fullDate.format(new Date(r.created)) : "—"}</td>
    </tr>`).join("") || '<tr><td colspan="9" class="muted">검색 결과가 없습니다.</td></tr>';
}

/* ---------- page ---------- */

function statusLabel(latest, now = new Date()) {
  const morning = new Date(`${dayKey(now)}T07:00:00+09:00`);
  const pending = now >= morning && dateOf(latest) < morning;
  return `최종 수집 ${latest.captured_kst} · 매일 07:00 KST 예약${pending ? " · 오늘 수집 대기·지연 중" : ""} · 화면은 1분마다 갱신`;
}

function render() {
  const daily = dailySnapshots(history.snapshots);
  const latest = daily.at(-1), previous = daily.at(-2);
  if (!latest) throw new Error("아직 저장된 스냅샷이 없습니다.");
  const sum = totals(latest), recent = growth(latest, previous);
  const status = document.getElementById("status");
  status.textContent = statusLabel(latest);
  status.classList.remove("error");
  document.getElementById("metric-tracked").textContent = `${latest.items.length}개`;
  document.getElementById("metric-totals").textContent = `누적 메시지 ${fmt(sum.message_count)} · 좋아요 ${fmt(sum.like_count)}`;
  document.getElementById("metric-msg-growth").textContent = recent ? signed(recent.msg) : "대기";
  document.getElementById("metric-like-growth").textContent = recent ? signed(recent.like) : "대기";
  document.getElementById("metric-window").textContent = `${daily.length}일`;
  document.querySelectorAll(".comparison-time").forEach((el) => {
    el.textContent = previous ? `${previous.captured_kst} 대비` : "내일 07:00 수집 후 비교";
  });

  const tail = daily.slice(-31);
  const dailyEntries = tail.slice(1).map((s, i) => ({ key: dayKey(dateOf(s)), label: dateLabel.format(dateOf(s)), growth: growth(s, tail[i]) }));
  renderGrowthPair("trend-chart", dailyEntries, "서로 다른 날짜에 두 번 이상 수집되면 표시됩니다.");
  renderAbsolutePair(daily);
  renderGrowthPair("weekly-chart", periodGrowth(daily, weekPeriod), "2주 이상 쌓이거나 한 주 안에 두 번 수집되면 표시됩니다.");
  renderGrowthPair("monthly-chart", periodGrowth(daily, monthPeriod), "한 달 안에 두 번 이상 수집되면 표시됩니다.");

  const rowsData = rows(latest, previous);
  renderModel(rowsData, Boolean(previous));
  renderTable(rowsData);
}

async function refreshData() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    history = await response.json();
    render();
  } catch (error) {
    const status = document.getElementById("status");
    status.textContent = history ? `갱신 실패 — 기존 데이터를 표시 중입니다 (${error.message})` : `데이터를 불러오지 못했습니다: ${error.message}`;
    status.classList.add("error");
  }
}

function rerender() { if (history) render(); }

document.getElementById("search").addEventListener("input", rerender);
document.querySelectorAll("#ranking-head th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  const key = th.dataset.sort;
  sortState = sortState.key === key ? { key, dir: -sortState.dir } : { key, dir: key === "rank" ? 1 : -1 };
  rerender();
}));
document.querySelectorAll(".seg").forEach((button) => button.addEventListener("click", () => {
  modelMode = button.dataset.model;
  document.querySelectorAll(".seg").forEach((b) => { b.classList.toggle("active", b === button); b.setAttribute("aria-selected", String(b === button)); });
  rerender();
}));

// 공용 툴팁: data-tip 을 가진 요소 위에서 표시
const tooltip = document.getElementById("tooltip");
document.addEventListener("mousemove", (event) => {
  const target = event.target.closest?.("[data-tip]");
  document.querySelectorAll(".hover-guide.on").forEach((g) => g.classList.remove("on"));
  if (!target) { tooltip.hidden = true; return; }
  if (target.nextElementSibling?.classList.contains("hover-guide")) target.nextElementSibling.classList.add("on");
  tooltip.innerHTML = target.dataset.tip;
  tooltip.hidden = false;
  const { innerWidth: vw } = window, rect = tooltip.getBoundingClientRect();
  const left = Math.min(event.clientX + 14, vw - rect.width - 8);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY - rect.height - 12)}px`;
});

refreshData();
setInterval(refreshData, 60000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshData(); });
