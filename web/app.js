const FIELD_MM = 12 * 304.8;
const ORIGIN = "center";
const IMAGES = { match: "assets/match.png", skills: "assets/skills.png" };
const FLOOR_INSET = 34 / 2000;
const FONT = 'Arial, Helvetica, sans-serif';
document.documentElement.style.setProperty("--font", FONT);

const LIFT_RISE_MM = 40;
const LIFT_FALL_MM = 10;
const SCORE_CLUSTER_MM = 250;
const SPEED_WINDOW_MS = 200;

const TEMP_WARN = 55;
const TEMP_MAX = 70;
const PATH_COLORS = ["#ff8a00", "#f2e100", "#4cd964", "#ff4fd8", "#ffffff", "#ff5a5a", "#b57bff", "#00d1b2"];
const GROUP_COLORS = { "Drive L": "#e8e8e8", "Drive R": "#8f8f8f", "Lift": "#c9b037", "Other": "#4fb36b" };

const $ = (id) => document.getElementById(id);
const canvas = $("field");
const ctx = canvas.getContext("2d");
const chart = $("chart");
const cctx = chart.getContext("2d");

const state = {
  field: "match",
  images: {},
  samples: [],
  tempNames: [],
  groups: [],
  scores: [],
  spots: [],
  hasLift: false,
  hasClaw: false,
  periods: [],
  paths: [],
  hover: null,
  index: 0,
  playing: false,
  speed: 1,
  lastFrame: 0,
  clock: 0,
};

for (const [key, src] of Object.entries(IMAGES)) {
  const img = new Image();
  img.onload = () => { state.images[key] = img; draw(); };
  img.src = src;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const empty = { samples: [], tempNames: [], hasLift: false, hasClaw: false };
  if (lines.length < 2) return empty;
  const head = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ti = col("t_ms", "t", "time");
  const xi = col("x");
  const yi = col("y");
  const hi = col("theta", "heading", "th");
  const li = col("lift", "lift_pos");
  const ci = col("claw", "claw_state");
  const pi = col("period", "phase", "mode");
  const tempCols = head.map((h, i) => ({ h, i })).filter((o) => o.h.startsWith("temp_"));
  if (ti < 0 || xi < 0 || yi < 0) return empty;
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const t = parseFloat(c[ti]), x = parseFloat(c[xi]), y = parseFloat(c[yi]);
    if ([t, x, y].some(Number.isNaN)) continue;
    out.push({
      t, x, y,
      th: hi >= 0 ? parseFloat(c[hi]) || 0 : 0,
      lift: li >= 0 ? parseFloat(c[li]) : NaN,
      claw: ci >= 0 && parseFloat(c[ci]) > 0 ? 1 : 0,
      temps: tempCols.map((o) => parseFloat(c[o.i])),
      period: pi >= 0 ? parsePeriod(c[pi]) : 0,
    });
  }
  return {
    samples: out,
    tempNames: tempCols.map((o) => o.h.slice(5)),
    hasLift: li >= 0,
    hasClaw: ci >= 0,
  };
}

function parsePeriod(v) {
  const t = (v || "").trim().toLowerCase();
  if (t === "1" || t.startsWith("a")) return 1;
  if (t === "2" || t.startsWith("d") || t.startsWith("u")) return 2;
  return 0;
}

function computeSpeed(s) {
  const half = SPEED_WINDOW_MS / 2;
  let a = 0, b = 0;
  for (let i = 0; i < s.length; i++) {
    while (s[a].t < s[i].t - half) a++;
    if (b < i) b = i;
    while (b + 1 < s.length && s[b + 1].t <= s[i].t + half) b++;
    const dt = s[b].t - s[a].t;
    s[i].speed = dt > 0 ? (Math.hypot(s[b].x - s[a].x, s[b].y - s[a].y) / dt) * 1000 : 0;
  }
}

function detectPeriods(s) {
  const out = [];
  const kind = (k) => (k === 1 ? "auto" : "driver");
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const k = s[i].period;
    if (cur && cur.k === k) { cur.b = i; continue; }
    if (cur && cur.k) out.push({ kind: kind(cur.k), a: cur.a, b: i });
    cur = { k, a: i, b: i };
  }
  if (cur && cur.k) out.push({ kind: kind(cur.k), a: cur.a, b: s.length - 1 });
  return out;
}

function detectScores(s) {
  const out = [];
  let h = null;
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    if (isNaN(p.lift)) continue;
    if (p.claw) {
      if (!h) {
        h = { grab: i, base: p.lift, peak: p.lift, peakIdx: i, up: -1, down: -1 };
        continue;
      }
      if (p.lift > h.peak) { h.peak = p.lift; h.peakIdx = i; h.down = -1; }
      if (h.up < 0 && h.peak - h.base >= LIFT_RISE_MM) h.up = i;
      if (h.up >= 0 && h.down < 0 && h.peak - p.lift >= LIFT_FALL_MM) h.down = i;
    } else if (h) {
      if (h.up >= 0 && h.down >= 0) {
        out.push({ grab: h.grab, up: h.up, peak: h.peakIdx, down: h.down, release: i });
      }
      h = null;
    }
  }
  return out;
}

function tempGroup(name) {
  if (/^drive_.l$/.test(name)) return "Drive L";
  if (/^drive_.r$/.test(name)) return "Drive R";
  if (/^lift/.test(name)) return "Lift";
  return "Other";
}
function tempLabel(name) {
  return name
    .replace(/^drive_(..)$/, (_, a) => "Drive " + a.toUpperCase())
    .replace(/^lift(\d)$/, "Lift $1");
}
function tempColor(k) { return GROUP_COLORS[tempGroup(state.tempNames[k])]; }

function buildGroups(s) {
  const names = [...new Set(state.tempNames.map(tempGroup))];
  state.groups = names.map((g) => ({
    name: g,
    idx: state.tempNames.map((n, i) => (tempGroup(n) === g ? i : -1)).filter((i) => i >= 0),
  }));
  for (const p of s) {
    p.g = state.groups.map((gr) => {
      let m = NaN;
      for (const i of gr.idx) {
        const v = p.temps[i];
        if (!isNaN(v) && (isNaN(m) || v > m)) m = v;
      }
      return m;
    });
  }
}

function clusterScores(s, scores) {
  const out = [];
  scores.forEach((sc, k) => {
    const p = s[sc.release];
    let c = out.find((o) => Math.hypot(o.x - p.x, o.y - p.y) <= SCORE_CLUSTER_MM);
    if (!c) {
      c = { x: p.x, y: p.y, n: 0, members: [] };
      out.push(c);
    }
    c.x = (c.x * c.n + p.x) / (c.n + 1);
    c.y = (c.y * c.n + p.y) / (c.n + 1);
    c.n++;
    c.members.push(k);
  });
  return out;
}

function buildTempList() {
  const dl = $("tempList");
  dl.innerHTML = "";
  state.tempNames.forEach((name, k) => {
    const dt = document.createElement("dt");
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = tempColor(k);
    dt.append(sw, tempLabel(name));
    const dd = document.createElement("dd");
    dd.id = "tmp" + k;
    dd.textContent = "-";
    dl.append(dt, dd);
  });
}

function setData(name, text) {
  const d = parseCsv(text);
  state.samples = d.samples;
  state.tempNames = d.tempNames;
  state.hasLift = d.hasLift;
  state.hasClaw = d.hasClaw;
  computeSpeed(d.samples);
  state.scores = detectScores(d.samples);
  state.periods = detectPeriods(d.samples);
  buildGroups(d.samples);
  state.spots = clusterScores(d.samples, state.scores);
  buildTempList();
  state.index = 0;
  state.clock = 0;
  setPlaying(false);
  const n = state.samples.length;
  $("scrub").max = Math.max(0, n - 1);
  $("scrub").value = 0;
  $("status").textContent = n ? `${name} - ${n} data points` : "";
  update();
}

function fieldRect() {
  return { x: 0, y: 0, w: canvas.width, h: canvas.height };
}
function toPx(xmm, ymm) {
  const r = fieldRect();
  const ox = ORIGIN === "center" ? FIELD_MM / 2 : 0;
  const oy = ORIGIN === "center" ? FIELD_MM / 2 : 0;
  const k = 1 - 2 * FLOOR_INSET;
  return {
    x: r.x + (FLOOR_INSET + ((xmm + ox) / FIELD_MM) * k) * r.w,
    y: r.y + (1 - FLOOR_INSET - ((ymm + oy) / FIELD_MM) * k) * r.h,
  };
}

function resize() {
  const stage = $("stage");
  const size = Math.max(200, Math.min(stage.clientWidth, stage.clientHeight) - 24);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = canvas.style.height = size + "px";
  canvas.width = canvas.height = Math.round(size * dpr);
  chart.width = Math.round(chart.clientWidth * dpr);
  chart.height = Math.round(chart.clientHeight * dpr);
  draw();
}

let chartGeom = null;

function extent(vals) {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

function plotLine(s, getV, tx, ty, color, w) {
  cctx.strokeStyle = color;
  cctx.lineWidth = w;
  cctx.lineJoin = "round";
  cctx.beginPath();
  let pen = false;
  for (const p of s) {
    const v = getV(p);
    if (isNaN(v)) { pen = false; continue; }
    const X = tx(p.t), Y = ty(v);
    pen ? cctx.lineTo(X, Y) : cctx.moveTo(X, Y);
    pen = true;
  }
  cctx.stroke();
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const W = chart.width, H = chart.height;
  cctx.clearRect(0, 0, W, H);
  const s = state.samples;
  chartGeom = null;
  if (!s.length || !W) {
    cctx.fillStyle = "#555";
    cctx.font = `${13 * dpr}px ${FONT}`;
    cctx.textAlign = "center";
    cctx.textBaseline = "middle";
    cctx.fillText("No data loaded", W / 2, H / 2);
    return;
  }
  const total = s[s.length - 1].t || 1;
  const x0 = 150 * dpr, x1 = W - 14 * dpr, padY = 6 * dpr, gap = 8 * dpr;
  chartGeom = { x0, x1, total };
  const tx = (t) => x0 + (t / total) * (x1 - x0);

  const tracks = [];
  if (state.periods.length && $("lyPeriod").checked) tracks.push({ id: "period", label: "Period", w: 1 });
  if ($("lySpeed").checked) tracks.push({ id: "speed", label: "Speed", w: 2 });
  if ($("lyLift").checked && state.hasLift) tracks.push({ id: "lift", label: "Lift", w: 2 });
  if ($("lyLift").checked && state.hasClaw) tracks.push({ id: "claw", label: "Claw", w: 1 });
  if ($("lyScore").checked && state.scores.length) {
    tracks.push({ id: "cascade", label: "Scores", w: Math.max(1.5, Math.min(3, state.scores.length * 0.5)) });
  }
  if ($("lyTemps").checked && state.tempNames.length) tracks.push({ id: "temps", label: "Temps", w: 4 });

  const wsum = tracks.reduce((a, t) => a + t.w, 0);
  const avail = H - 2 * padY - gap * Math.max(0, tracks.length - 1);
  let y = padY;
  cctx.font = `${12 * dpr}px ${FONT}`;

  for (const tr of tracks) {
    tr.y0 = y;
    tr.y1 = y + (avail * tr.w) / wsum;
    y = tr.y1 + gap;
    const h = tr.y1 - tr.y0;

    cctx.fillStyle = "#161616";
    cctx.fillRect(x0, tr.y0, x1 - x0, h);
    cctx.font = `bold ${14 * dpr}px ${FONT}`;
    cctx.fillStyle = "#b8b8b8";
    cctx.textAlign = "left";
    cctx.textBaseline = "top";
    cctx.fillText(tr.label, 10 * dpr, tr.y0 + 3 * dpr);
    cctx.font = `${12 * dpr}px ${FONT}`;

    cctx.save();
    cctx.beginPath();
    cctx.rect(x0, tr.y0, x1 - x0, h);
    cctx.clip();

    if (tr.id === "speed") {
      const [, mx] = extent(s.map((p) => p.speed));
      const hi = Math.max(mx, 100) * 1.05;
      const ty = (v) => tr.y1 - (v / hi) * h;
      plotLine(s, (p) => p.speed, tx, ty, "#4fa3e0", 1.5 * dpr);
      tr.axis = [hi, 0, " mm/s"];
    } else if (tr.id === "lift") {
      const [mn, mx] = extent(s.map((p) => p.lift));
      const lo = Math.min(0, mn), hi = Math.max(mx, LIFT_RISE_MM) * 1.05;
      const ty = (v) => tr.y1 - ((v - lo) / (hi - lo)) * h;
      plotLine(s, (p) => p.lift, tx, ty, "#e8e8e8", 1.5 * dpr);
      tr.axis = [hi, lo, " mm"];
    } else if (tr.id === "claw") {
      cctx.fillStyle = "#8f8f8f";
      let start = null;
      for (let i = 0; i < s.length; i++) {
        if (s[i].claw && start === null) start = s[i].t;
        if ((!s[i].claw || i === s.length - 1) && start !== null) {
          cctx.fillRect(tx(start), tr.y0 + 2 * dpr, tx(s[i].t) - tx(start), h - 4 * dpr);
          start = null;
        }
      }
    } else if (tr.id === "period") {
      cctx.font = `bold ${13 * dpr}px ${FONT}`;
      cctx.textAlign = "center";
      cctx.textBaseline = "middle";
      for (const pd of state.periods) {
        const xa = tx(s[pd.a].t), xb = tx(s[pd.b].t);
        cctx.fillStyle = pd.kind === "auto" ? "#4a4a4a" : "#2c2c2c";
        cctx.fillRect(xa, tr.y0, xb - xa, h);
        cctx.fillStyle = "#e8e8e8";
        cctx.fillText(pd.kind === "auto" ? "Auto" : "Driver", (xa + xb) / 2, tr.y0 + h / 2 + dpr);
      }
      cctx.font = `${12 * dpr}px ${FONT}`;
    } else if (tr.id === "cascade") {
      const n = state.scores.length;
      const rh = Math.min(14 * dpr, (h - 4 * dpr) / n);
      const bh = Math.max(3 * dpr, rh - 3 * dpr);
      state.scores.forEach((sc, k) => {
        const yy = tr.y0 + 2 * dpr + k * rh;
        cctx.globalAlpha = sc.release <= state.index ? 1 : 0.4;
        const seg = (a, b, color) => {
          const xa = tx(s[a].t), xb = tx(s[b].t);
          cctx.fillStyle = color;
          cctx.fillRect(xa, yy, Math.max(2 * dpr, xb - xa), bh);
        };
        seg(sc.grab, sc.peak, "#8f8f8f");
        seg(sc.peak, sc.down, "#e8e8e8");
        seg(sc.down, sc.release, "#555");
        const xr = tx(s[sc.release].t);
        cctx.fillStyle = "#ff8a00";
        cctx.fillRect(xr - dpr, yy - dpr, 2 * dpr, bh + 2 * dpr);
        cctx.globalAlpha = 1;
        cctx.font = `bold ${13 * dpr}px ${FONT}`;
        cctx.fillStyle = sc.release <= state.index ? "#e8e8e8" : "#9a9a9a";
        cctx.textAlign = "left";
        cctx.textBaseline = "middle";
        cctx.fillText(String(k + 1), xr + 6 * dpr, yy + bh / 2 + dpr * 0.5);
      });
      cctx.globalAlpha = 1;
      cctx.font = `${12 * dpr}px ${FONT}`;
    } else {
      const all = s.flatMap((p) => p.g);
      const [mn, mx] = extent(all);
      const lo = Math.floor(mn / 5) * 5, hi = Math.max(Math.ceil(mx / 5) * 5, lo + 5);
      const ty = (v) => tr.y1 - ((v - lo) / (hi - lo)) * h;
      for (const lv of [TEMP_WARN, TEMP_MAX]) {
        if (lv < lo || lv > hi) continue;
        cctx.setLineDash([4 * dpr, 4 * dpr]);
        cctx.strokeStyle = "#d94f4f";
        cctx.lineWidth = dpr;
        cctx.beginPath();
        cctx.moveTo(x0, ty(lv));
        cctx.lineTo(x1, ty(lv));
        cctx.stroke();
        cctx.setLineDash([]);
      }
      state.groups.forEach((gr, gi) => {
        plotLine(s, (p) => p.g[gi], tx, ty, GROUP_COLORS[gr.name], 1.8 * dpr);
      });
      tr.axis = [hi, lo, "\u00b0C"];
    }
    cctx.restore();

    if (tr.axis) {
      cctx.fillStyle = "#8a8a8a";
      cctx.textAlign = "right";
      cctx.textBaseline = "top";
      cctx.fillText(Math.round(tr.axis[0]) + tr.axis[2], x0 - 8 * dpr, tr.y0 + 3 * dpr);
      cctx.textBaseline = "bottom";
      cctx.fillText(Math.round(tr.axis[1]) + tr.axis[2], x0 - 8 * dpr, tr.y1 - 3 * dpr);
    }
    if (tr.id === "temps") {
      cctx.textAlign = "left";
      cctx.textBaseline = "middle";
      const labelH = 22 * dpr;
      const rowH = Math.min(14 * dpr, (h - labelH - 4 * dpr) / Math.max(1, state.groups.length));
      const top = tr.y0 + labelH + rowH / 2;
      state.groups.forEach((gr, i) => {
        const ly = top + i * rowH;
        cctx.fillStyle = GROUP_COLORS[gr.name];
        cctx.fillRect(10 * dpr, ly - 1.5 * dpr, 12 * dpr, 3 * dpr);
        cctx.fillText(gr.name, 28 * dpr, ly);
      });
    }
  }

  if ($("lyScore").checked) {
    cctx.strokeStyle = "rgba(240,240,240,0.3)";
    cctx.lineWidth = dpr;
    for (const sc of state.scores) {
      const X = tx(s[sc.release].t);
      cctx.beginPath();
      cctx.moveTo(X, padY);
      cctx.lineTo(X, H - padY);
      cctx.stroke();
    }
  }

  cctx.setLineDash([3 * dpr, 3 * dpr]);
  cctx.strokeStyle = "rgba(240,240,240,0.4)";
  cctx.lineWidth = dpr;
  for (const pd of state.periods) {
    if (pd.a === 0 || !$("lyPeriod").checked) continue;
    const X = tx(s[pd.a].t);
    cctx.beginPath();
    cctx.moveTo(X, padY);
    cctx.lineTo(X, H - padY);
    cctx.stroke();
  }
  cctx.setLineDash([]);

  const px = tx(s[state.index].t);
  cctx.strokeStyle = "#ff8a00";
  cctx.lineWidth = 1.5 * dpr;
  cctx.beginPath();
  cctx.moveTo(px, padY);
  cctx.lineTo(px, H - padY);
  cctx.stroke();
}

function indexAtTime(t) {
  const s = state.samples;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function seekIndex(i) {
  const s = state.samples;
  if (!s.length) return;
  state.index = Math.max(0, Math.min(s.length - 1, i));
  state.clock = s[state.index].t;
  update();
}

function drawGrid() {
  ctx.strokeStyle = "#1f1f1f";
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const p = (i / 6) * canvas.width;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(canvas.width, p); ctx.stroke();
  }
}

function draw() {
  drawField();
  drawChart();
}

function segDist(pt, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

function offsetPaths(list) {
  const dpr = window.devicePixelRatio || 1;
  const thr = 7 * dpr;
  const gap = 5 * dpr;
  const polys = list.map((p) => p.pts.map(([x, y]) => toPx(x, y)));
  return polys.map((poly, pi) => {
    const raw = poly.map((pt) => {
      const group = [];
      for (let o = 0; o < polys.length; o++) {
        if (o === pi || segDist(pt, polys[o]) < thr) group.push(o);
      }
      return (group.indexOf(pi) - (group.length - 1) / 2) * gap;
    });
    const sm = raw.map((_, i) => {
      let sum = 0, n = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < raw.length) { sum += raw[j]; n++; }
      }
      return sum / n;
    });
    return poly.map((pt, i) => {
      const a = poly[Math.max(0, i - 1)], b = poly[Math.min(poly.length - 1, i + 1)];
      let dx = b.x - a.x, dy = b.y - a.y;
      if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      return { x: pt.x - dy * sm[i], y: pt.y + dx * sm[i] };
    });
  });
}

function drawArrows(poly, color, size) {
  const spacing = size * 9;
  let next = spacing * 0.5;
  let acc = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    while (next <= acc + len) {
      const t = next - acc;
      const cx = a.x + ux * t, cy = a.y + uy * t;
      ctx.beginPath();
      ctx.moveTo(cx + ux * size, cy + uy * size);
      ctx.lineTo(cx - ux * size - uy * size * 0.8, cy - uy * size + ux * size * 0.8);
      ctx.lineTo(cx - ux * size + uy * size * 0.8, cy - uy * size - ux * size * 0.8);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = "#000";
      ctx.lineWidth = size * 0.35;
      ctx.stroke();
      ctx.fill();
      next += spacing;
    }
    acc += len;
  }
}

function drawPaths() {
  const dpr = window.devicePixelRatio || 1;
  const on = state.paths.filter((p) => p.on);
  if (!on.length) return;
  const polys = offsetPaths(on);
  const hover = state.hover && state.hover.on ? state.hover : null;
  const order = on.map((_, i) => i).sort((a, b) => (on[a] === hover) - (on[b] === hover));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const k of order) {
    const p = on[k], poly = polys[k];
    ctx.globalAlpha = hover && hover !== p ? 0.25 : 1;
    const trace = () => {
      ctx.beginPath();
      poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
    };
    const w = hover === p ? 1.4 : 1;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.lineWidth = 6.5 * w * dpr;
    trace();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 3.5 * w * dpr;
    trace();
    drawArrows(poly, p.color, 4.5 * dpr);
    const e = poly[poly.length - 1];
    ctx.fillStyle = p.color;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2 * dpr;
    ctx.fillRect(e.x - 4 * dpr, e.y - 4 * dpr, 8 * dpr, 8 * dpr);
    ctx.strokeRect(e.x - 4 * dpr, e.y - 4 * dpr, 8 * dpr, 8 * dpr);
  }
  const placed = [];
  const r = 9 * dpr;
  ctx.font = `bold ${12 * dpr}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const k of order) {
    const p = on[k];
    ctx.globalAlpha = hover && hover !== p ? 0.25 : 1;
    const s0 = polys[k][0];
    const near = placed.filter((q) => Math.hypot(q.x - s0.x, q.y - s0.y) < r * 2).length;
    const bx = s0.x + near * (r * 2 + 2 * dpr), by = s0.y;
    placed.push({ x: bx, y: by });
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2.5 * dpr;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#000";
    ctx.fillText(String(p.num), bx, by + 0.5 * dpr);
  }
  ctx.globalAlpha = 1;
  ctx.textBaseline = "alphabetic";
}

function buildPathList() {
  const box = $("pathList");
  box.innerHTML = "";
  if (!state.paths.length) {
    box.innerHTML = '<div class="empty">None found</div>';
    return;
  }
  const boxes = [];
  const groups = [];

  const sync = () => {
    boxes.forEach((b) => { b.cb.checked = b.p.on; });
    groups.forEach((g) => {
      const on = g.members.filter((p) => p.on).length;
      g.cb.checked = on === g.members.length;
      g.cb.indeterminate = on > 0 && on < g.members.length;
    });
    const total = state.paths.filter((p) => p.on).length;
    all.checked = total === state.paths.length;
    all.indeterminate = total > 0 && total < state.paths.length;
  };

  const allLabel = document.createElement("label");
  allLabel.className = "pall";
  const all = document.createElement("input");
  all.type = "checkbox";
  all.onchange = () => {
    state.paths.forEach((p) => { p.on = all.checked; });
    sync();
    draw();
  };
  allLabel.append(all, "Select all");
  box.append(allLabel);

  const projects = [...new Set(state.paths.map((p) => p.project))];
  projects.forEach((proj) => {
    const members = state.paths.filter((p) => p.project === proj);
    const head = document.createElement("label");
    head.className = "pgroup";
    const gcb = document.createElement("input");
    gcb.type = "checkbox";
    gcb.onchange = () => {
      members.forEach((p) => { p.on = gcb.checked; });
      sync();
      draw();
    };
    head.append(gcb, proj);
    box.append(head);
    groups.push({ cb: gcb, members });
    members.forEach((p) => {
      const lb = document.createElement("label");
      lb.className = "pitem";
      lb.onmouseenter = () => { state.hover = p; draw(); };
      lb.onmouseleave = () => { state.hover = null; draw(); };
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.onchange = () => { p.on = cb.checked; sync(); draw(); };
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = p.color;
      lb.append(cb, sw, `${p.name} (${p.pts.length} pts)`);
      box.append(lb);
      boxes.push({ cb, p });
    });
  });
  sync();
}

async function loadPaths() {
  const r = await pywebview.api.load_paths();
  state.paths = r.map((p, i) => ({
    project: p.project,
    name: p.name,
    num: p.num,
    pts: p.points,
    color: PATH_COLORS[i % PATH_COLORS.length],
    on: false,
  }));
  buildPathList();
  draw();
}

function drawField() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const img = state.images[state.field];
  if (img) {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } else {
    drawGrid();
    ctx.fillStyle = "#555";
    ctx.font = `${canvas.width / 40}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(`Add web/${IMAGES[state.field]}`, canvas.width / 2, canvas.height / 2);
  }

  drawPaths();

  const s = state.samples;
  if (!s.length) return;
  const dpr = window.devicePixelRatio || 1;

  if ($("lyPath").checked) {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = "rgba(20,20,20,0.55)";
    ctx.beginPath();
    s.forEach((p, i) => {
      const q = toPx(p.x, p.y);
      i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    });
    ctx.stroke();
    const travelled = () => {
      ctx.beginPath();
      for (let i = 0; i <= state.index; i++) {
        const q = toPx(s[i].x, s[i].y);
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
    };
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 7 * dpr;
    travelled();
    ctx.strokeStyle = "#17063d";
    ctx.lineWidth = 4 * dpr;
    travelled();
  }

  if ($("lyScoreSpots").checked) {
    state.spots.forEach((c) => {
      const q = toPx(c.x, c.y);
      const done = c.members.filter((k) => state.scores[k].release <= state.index).length;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 15 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = "#111";
      ctx.strokeStyle = "#e8e8e8";
      ctx.lineWidth = 1.5 * dpr;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${12 * dpr}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${done}/${c.n}`, q.x, q.y + 0.5 * dpr);
    });
    ctx.textBaseline = "alphabetic";
  }

  if ($("lyRobot").checked) {
    const p = s[state.index];
    const q = toPx(p.x, p.y);
    const r = 7 * dpr;
    const a = (p.th * Math.PI) / 180;
    ctx.fillStyle = "#17063d";
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2 * dpr;
    ctx.fillRect(q.x - r, q.y - r, r * 2, r * 2);
    ctx.strokeRect(q.x - r, q.y - r, r * 2, r * 2);
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(q.x, q.y);
    ctx.lineTo(q.x + Math.cos(a) * r * 2, q.y - Math.sin(a) * r * 2);
    ctx.stroke();
  }
}

function update() {
  const s = state.samples;
  const p = s[state.index];
  $("scrub").value = state.index;
  const total = s.length ? s[s.length - 1].t : 0;
  $("timeLabel").textContent = `${((p ? p.t : 0) / 1000).toFixed(1)} / ${(total / 1000).toFixed(1)} s`;
  $("rTime").textContent = p ? (p.t / 1000).toFixed(2) + " s" : "-";
  $("rX").textContent = p ? p.x.toFixed(0) + " mm" : "-";
  $("rY").textContent = p ? p.y.toFixed(0) + " mm" : "-";
  $("rTh").textContent = p ? p.th.toFixed(1) + "\u00b0" : "-";
  $("rSpeed").textContent = p ? p.speed.toFixed(0) + " mm/s" : "-";
  $("rLift").textContent = p && !isNaN(p.lift) ? p.lift.toFixed(0) + " mm" : "-";
  $("rClaw").textContent = p && state.hasClaw ? (p.claw ? "Closed" : "Open") : "-";
  $("rPeriod").textContent = p && state.periods.length ? ["Idle", "Auto", "Driver"][p.period] : "-";
  $("rScore").textContent = p
    ? `${state.scores.filter((sc) => sc.release <= state.index).length} / ${state.scores.length}`
    : "-";
  state.tempNames.forEach((_, k) => {
    const v = p ? p.temps[k] : NaN;
    const el = $("tmp" + k);
    el.textContent = isNaN(v) ? "-" : v.toFixed(0) + " \u00b0C";
    el.style.color = v >= TEMP_WARN ? "#d94f4f" : "";
  });
  draw();
}

function setPlaying(on) {
  state.playing = on && state.samples.length > 0;
  $("btnPlay").textContent = state.playing ? "Pause" : "Play";
  if (state.playing) {
    if (state.index >= state.samples.length - 1) state.index = 0;
    state.clock = state.samples[state.index].t;
    state.lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
}

function tick(now) {
  if (!state.playing) return;
  state.clock += (now - state.lastFrame) * state.speed;
  state.lastFrame = now;
  const s = state.samples;
  while (state.index < s.length - 1 && s[state.index + 1].t <= state.clock) state.index++;
  update();
  if (state.index >= s.length - 1) return setPlaying(false);
  requestAnimationFrame(tick);
}

function bindSeg(id, attr, fn) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    fn(b.dataset[attr]);
  });
}
bindSeg("fieldToggle", "field", (v) => { state.field = v; draw(); });
bindSeg("speedToggle", "speed", (v) => { state.speed = parseFloat(v); });

$("btnPlay").onclick = () => setPlaying(!state.playing);
$("scrub").oninput = (e) => seekIndex(parseInt(e.target.value, 10));
const LAYER_IDS = ["lyPath", "lyRobot", "lyPeriod", "lySpeed", "lyLift", "lyScore", "lyScoreSpots", "lyTemps"];
const TIMELINE_IDS = ["lyPeriod", "lySpeed", "lyLift", "lyScore", "lyTemps"];

function layersChanged() {
  const on = LAYER_IDS.filter((id) => $(id).checked).length;
  $("lyAll").checked = on === LAYER_IDS.length;
  $("lyAll").indeterminate = on > 0 && on < LAYER_IDS.length;
  const show = TIMELINE_IDS.some((id) => $(id).checked);
  const was = $("charts").style.display !== "none";
  $("charts").style.display = show ? "" : "none";
  if (show !== was) resize();
  else draw();
}

LAYER_IDS.forEach((id) => ($(id).onchange = layersChanged));
$("lyAll").onchange = () => {
  LAYER_IDS.forEach((id) => { $(id).checked = $("lyAll").checked; });
  layersChanged();
};
layersChanged();

let chartDrag = false;
function chartSeek(e) {
  if (!chartGeom || !state.samples.length) return;
  const dpr = window.devicePixelRatio || 1;
  const px = (e.clientX - chart.getBoundingClientRect().left) * dpr;
  const f = Math.max(0, Math.min(1, (px - chartGeom.x0) / (chartGeom.x1 - chartGeom.x0)));
  seekIndex(indexAtTime(f * chartGeom.total));
}
chart.addEventListener("pointerdown", (e) => { chartDrag = true; chart.setPointerCapture(e.pointerId); chartSeek(e); });
chart.addEventListener("pointermove", (e) => { if (chartDrag) chartSeek(e); });
chart.addEventListener("pointerup", () => { chartDrag = false; });

let activeRun = null;

let undoCount = 0;
function setUndo(n) {
  undoCount = n;
}

function flash(msg) {
  $("status").textContent = msg;
}

function renderRuns(files) {
  const ul = $("runList");
  ul.innerHTML = "";
  if (!files.length) {
    ul.innerHTML = '<li class="empty">No CSV files</li>';
    return;
  }
  files.forEach((f) => {
    const li = document.createElement("li");
    li.title = f.path;
    if (f.path === activeRun) li.classList.add("active");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = f.name;

    const ren = document.createElement("button");
    ren.className = "act";
    ren.textContent = "\u270E";
    ren.title = "Rename";
    const del = document.createElement("button");
    del.className = "act";
    del.textContent = "\u2715";
    del.title = "Delete (can be undone until the app closes)";

    li.onclick = async () => {
      activeRun = f.path;
      ul.querySelectorAll("li").forEach((x) => x.classList.toggle("active", x === li));
      if (f.read) {
        setData(f.name, await f.read());
        return;
      }
      const r = await pywebview.api.read_file(f.path);
      if (r.ok) setData(r.name, r.text);
    };

    del.onclick = async (e) => {
      e.stopPropagation();
      const r = await pywebview.api.delete_file(f.path);
      if (!r.ok) { flash(r.error); return; }
      if (activeRun === f.path) activeRun = null;
      setUndo(r.undo);
      flash(`Deleted ${f.name} (Ctrl+Z to undo)`);
      loadDrive();
    };

    ren.onclick = (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.value = f.name;
      li.replaceChildren(input);
      input.focus();
      input.setSelectionRange(0, f.name.replace(/\.csv$/i, "").length);
      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        if (commit && input.value.trim() && input.value !== f.name) {
          const r = await pywebview.api.rename_file(f.path, input.value);
          if (r.ok) {
            if (activeRun === f.path) activeRun = r.path;
            flash(`Renamed to ${r.name}`);
          } else {
            flash(r.error);
          }
        }
        loadDrive();
      };
      input.onclick = (ev) => ev.stopPropagation();
      input.onkeydown = (ev) => {
        if (ev.key === "Enter") finish(true);
        else if (ev.key === "Escape") finish(false);
      };
      input.onblur = () => finish(true);
    };

    if (f.read) li.append(nm);
    else li.append(nm, ren, del);
    ul.appendChild(li);
  });
}

async function undoDelete() {
  const r = await pywebview.api.undo_delete();
  setUndo(r.undo);
  flash(r.ok ? `Restored ${r.name}` : r.error);
  if (r.ok) loadDrive();
}
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "z" && e.target.tagName !== "INPUT" && undoCount > 0) {
    e.preventDefault();
    undoDelete();
  }
});

let desktop = false;
let localRuns = [];

async function loadDrive() {
  const r = await pywebview.api.load_drive();
  if (!r.ok) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = r.error;
    $("runList").replaceChildren(li);
    return;
  }
  renderRuns(r.files);
}

async function loadDriveList() {
  const r = await pywebview.api.list_drives();
  const sel = $("driveSelect");
  sel.replaceChildren();
  r.drives.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.root;
    opt.textContent = d.label ? `${d.root} ${d.label}` : d.root;
    sel.appendChild(opt);
  });
  if (r.selected) sel.value = r.selected;
  return r.selected;
}

async function refreshDrive() {
  await loadDriveList();
  await loadDrive();
}

const WEB_MAX_DEPTH = 2;
const WEB_SKIPPED = new Set(["$recycle.bin", "system volume information"]);

function naturalKey(s) {
  return s.split(/(\d+)/).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t.toLowerCase()));
}
function naturalCompare(a, b) {
  const ka = naturalKey(a.name), kb = naturalKey(b.name);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    if (ka[i] === kb[i]) continue;
    if (typeof ka[i] === typeof kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return typeof ka[i] === "number" ? -1 : 1;
  }
  return ka.length - kb.length;
}

function fileRun(name, file) {
  return { name, path: name, read: () => file.text() };
}

function showRuns(runs, label) {
  localRuns = runs.sort(naturalCompare);
  activeRun = null;
  renderRuns(localRuns);
  if (label) flash(`${label} - ${runs.length} CSV file${runs.length === 1 ? "" : "s"}`);
}

async function addLocalFiles(files) {
  const list = Array.from(files).filter((f) => /\.csv$/i.test(f.name));
  if (!list.length) return;
  const merged = localRuns.filter((x) => !list.some((f) => f.name === x.path));
  list.forEach((f) => merged.push(fileRun(f.name, f)));
  showRuns(merged);
  const last = list[list.length - 1];
  activeRun = last.name;
  renderRuns(localRuns);
  setData(last.name, await last.text());
}

async function walkDirectory(dir, prefix, depth, out) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file" && /\.csv$/i.test(name)) {
      out.push({ name: prefix + name, path: prefix + name, read: async () => (await h.getFile()).text() });
    } else if (h.kind === "directory" && depth < WEB_MAX_DEPTH - 1 && !WEB_SKIPPED.has(name.toLowerCase())) {
      await walkDirectory(h, prefix + name + "/", depth + 1, out);
    }
  }
}

async function openDirectoryHandle(dir) {
  const out = [];
  try {
    await walkDirectory(dir, "", 0, out);
  } catch (e) {
    flash("Could not read that drive");
    return;
  }
  showRuns(out, dir.name || "Drive");
}

function openDirectoryFiles(files) {
  const list = Array.from(files).filter((f) => /\.csv$/i.test(f.name));
  const root = list.length && list[0].webkitRelativePath ? list[0].webkitRelativePath.split("/")[0] : "Drive";
  const runs = [];
  for (const f of list) {
    const parts = (f.webkitRelativePath || f.name).split("/").slice(1);
    if (!parts.length || parts.length > WEB_MAX_DEPTH) continue;
    if (parts.slice(0, -1).some((d) => WEB_SKIPPED.has(d.toLowerCase()))) continue;
    runs.push(fileRun(parts.join("/"), f));
  }
  showRuns(runs, root);
}

async function openFolder() {
  if (!window.showDirectoryPicker) {
    $("folderInput").click();
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ id: "telemetry-drive", mode: "read" });
    await openDirectoryHandle(dir);
  } catch (e) {
    if (e.name !== "AbortError") flash("Could not open that drive");
  }
}

async function loadDemo() {
  try {
    const res = await fetch("assets/sample.csv");
    if (!res.ok) return;
    const text = await res.text();
    localRuns = [{ name: "sample.csv", path: "sample.csv", read: async () => text }];
    activeRun = "sample.csv";
    renderRuns(localRuns);
    setData("sample.csv", text);
  } catch (e) {
    flash("Could not load demo");
  }
}

$("btnDrive").onclick = refreshDrive;
$("driveSelect").onchange = async (e) => {
  const r = await pywebview.api.select_drive(e.target.value);
  if (!r.ok) flash(r.error);
  loadDrive();
};
$("btnOpen").onclick = async () => {
  if (!desktop) {
    $("fileInput").click();
    return;
  }
  const r = await pywebview.api.pick_file();
  if (r.ok) setData(r.name, r.text);
};
$("btnDemo").onclick = loadDemo;
$("btnFolder").onclick = openFolder;
$("folderInput").onchange = (e) => {
  openDirectoryFiles(e.target.files);
  e.target.value = "";
};
$("fileInput").onchange = (e) => {
  addLocalFiles(e.target.files);
  e.target.value = "";
};

window.addEventListener("dragover", (e) => {
  if (desktop) return;
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", async (e) => {
  if (desktop) return;
  e.preventDefault();
  document.body.classList.remove("dragging");
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (item && item.getAsFileSystemHandle) {
    const h = await item.getAsFileSystemHandle();
    if (h && h.kind === "directory") {
      openDirectoryHandle(h);
      return;
    }
  }
  addLocalFiles(e.dataTransfer.files);
});

window.addEventListener("resize", resize);
window.addEventListener("pywebviewready", () => {
  desktop = true;
  document.body.classList.add("desktop");
  refreshDrive();
  loadPaths();
});
window.addEventListener("load", () => {
  setTimeout(() => {
    if (!desktop) loadDemo();
  }, 400);
});
resize();
