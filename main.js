'use strict';

const {
  Plugin,
  PluginSettingTab,
  ItemView,
  Modal,
  Notice,
  Menu,
  Setting,
  Component,
  MarkdownRenderer,
  TFile,
  moment,
  setIcon,
} = require('obsidian');

// ---------- 常量 ----------

const VIEW_TYPE = 'workmap-view';
const TEMPLATE_PATH = 'tools/period-template.md';
const PERIOD_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{1,2})\.md$/;
const PERIOD_HEAD_RE = /^##\s+(周期任务|四象限)\s*$/;
const DAY_HEAD_RE = /^##\s+(\d{1,2})\s*$/;
const H12_RE = /^#{1,2}\s/;
const HR_RE = /^---\s*$/;
const TASK_RE = /^- \[([ xX])\] ?(.*)$/;
const EMPTY_TASK_RE = /^- \[ \]\s*$/;
const META_RE = /\s*%%(m|p|t|id):([^%\n]*)%%/g;
const DUE_RE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const STAR_RE = /\s*(★{1,3})(?=\s|$)/;
const HABIT_RE = /^习惯[：:]\s*(.*)$/;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const LEVEL_NAMES = ['不标星', '一般', '重要', '最重要'];
const SIZES = { s: 14, m: 16, l: 18, xl: 20 };

const DEFAULT_SETTINGS = {
  hideDone: false,
  habits: ['REVIEW', 'workoUT', 'MeD+MilK', 'book&KK', 'code&write'],
  slots: ['07-09', '09-11', '11-12', '14-16', '16-18', '20-22', '22-24'],
  theme: 'auto',
  size: 'm',
  hideTips: false,
  carry: null,
  fx: true,
  sky: true,
};

// x/y 仍写进 %%m:x,y%%：x、y 决定象限，y 同时决定象限内的排序
const QUADS = {
  1: { name: '重要且紧急', title: '马上做', sub: '重要 · 紧急', icon: 'flame', x: 75, lo: 4, hi: 46 },
  2: { name: '重要不紧急', title: '排时间做', sub: '重要 · 不紧急', icon: 'calendar-clock', x: 25, lo: 4, hi: 46 },
  3: { name: '不重要不紧急', title: '少做或不做', sub: '不重要 · 不紧急', icon: 'coffee', x: 25, lo: 54, hi: 96 },
  4: { name: '紧急不重要', title: '尽快处理', sub: '紧急 · 不重要 · 可交给别人', icon: 'send', x: 75, lo: 54, hi: 96 },
};

const DEFAULT_TEMPLATE = `[🧭 打开 Workmap](obsidian://workmap)

## 周期任务

{{tasks}}

---

## {{day}}

`;

// ---------- 编辑器里隐藏元数据 ----------

let editorExt = null;
try {
  const { ViewPlugin, Decoration, MatchDecorator } = require('@codemirror/view');
  const { editorLivePreviewField } = require('obsidian');
  const metaDecorator = new MatchDecorator({
    regexp: /\s?%%(?:m|p|t|id):[^%\n]*%%/g,
    decoration: Decoration.replace({}),
  });
  const isLive = state => !!state.field(editorLivePreviewField, false);
  editorExt = ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = isLive(view.state) ? metaDecorator.createDeco(view) : Decoration.none;
    }

    update(u) {
      if (!isLive(u.state)) {
        this.decorations = Decoration.none;
      } else if (!isLive(u.startState) || this.decorations === Decoration.none) {
        this.decorations = metaDecorator.createDeco(u.view);
      } else {
        this.decorations = metaDecorator.updateDeco(u, this.decorations);
      }
    }
  }, { decorations: v => v.decorations });
} catch (e) {
  console.warn('[workmap] 无法加载编辑器扩展', e);
}

// ---------- 纯函数：解析与格式化 ----------

function pad(n) {
  return String(n).padStart(2, '0');
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function newId() {
  return 'p' + Math.random().toString(36).slice(2, 6);
}

function splitLines(data) {
  const eol = data.includes('\r\n') ? '\r\n' : '\n';
  return { lines: data.split(/\r?\n/), eol };
}

function periodRange(lines) {
  const start = lines.findIndex(l => PERIOD_HEAD_RE.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (H12_RE.test(lines[i]) || HR_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function listDays(lines) {
  const days = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DAY_HEAD_RE.exec(lines[i]);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (H12_RE.test(lines[j])) {
        end = j;
        break;
      }
    }
    days.push({ day: +m[1], start: i, end });
  }
  return days;
}

function dayRange(lines, day) {
  return listDays(lines).find(d => d.day === day) || null;
}

function rangeOf(lines, scope) {
  return scope.kind === 'period' ? periodRange(lines) : dayRange(lines, scope.day);
}

function countChildren(lines, idx, end) {
  let n = 0;
  while (idx + 1 + n < end && /^\s+\S/.test(lines[idx + 1 + n])) n++;
  return n;
}

function readNote(lines, idx, n) {
  const ls = lines.slice(idx + 1, idx + 1 + n);
  if (!ls.length) return '';
  const ind = Math.min(...ls.map(l => /^\s*/.exec(l)[0].length));
  return ls.map(l => l.slice(ind)).join('\n');
}

function noteLines(note) {
  return (note || '')
    .split(/\r?\n/)
    .filter(l => l.trim())
    .map(l => '  ' + l.replace(/\s+$/, ''));
}

function parseTaskLine(line, i) {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const meta = {};
  let body = m[2].replace(META_RE, (_, k, v) => {
    meta[k] = v.trim();
    return '';
  });
  let due = '';
  const dm = DUE_RE.exec(body);
  if (dm) {
    due = dm[1];
    body = body.replace(DUE_RE, '');
  }
  let level = 0;
  const st = STAR_RE.exec(body);
  if (st) {
    level = st[1].length;
    body = body.replace(STAR_RE, '');
  }
  body = body.trim();
  const sm = /^\*\*(.+)\*\*$/.exec(body);
  if (sm) {
    if (!level) level = 3;
    body = sm[1].trim();
  }
  let x = null;
  let y = null;
  if (meta.m) {
    const [a, b] = meta.m.split(',').map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      x = clamp(a, 0, 100);
      y = clamp(b, 0, 100);
    }
  }
  return {
    line: i,
    raw: line,
    done: m[1] !== ' ',
    text: body,
    level,
    due,
    x,
    y,
    id: meta.id || '',
    parent: meta.p || '',
    slot: meta.t || '',
  };
}

function collectTasks(lines, range, kind) {
  const tasks = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const t = parseTaskLine(lines[i], i);
    if (!t || !t.text) continue;
    t.kind = kind;
    t.children = countChildren(lines, i, range.end);
    t.note = t.children ? readNote(lines, i, t.children) : '';
    if (kind === 'period') {
      t.x = null;
      t.y = null;
    }
    tasks.push(t);
  }
  return tasks;
}

function formatTask(t) {
  let s = `- [${t.done ? 'x' : ' '}] ${t.text}`;
  if (t.level) s += ' ' + '★'.repeat(clamp(t.level, 1, 3));
  if (t.due) s += ` 📅 ${t.due}`;
  if (t.id) s += ` %%id:${t.id}%%`;
  if (t.parent) s += ` %%p:${t.parent}%%`;
  if (t.slot) s += ` %%t:${t.slot}%%`;
  if (t.x != null && t.y != null) s += ` %%m:${Math.round(t.x)},${Math.round(t.y)}%%`;
  return s;
}

function taskBlock(t) {
  return [formatTask(t), ...noteLines(t.note)];
}

function findRaw(lines, range, raw) {
  for (let i = range.start + 1; i < range.end; i++) {
    if (lines[i] === raw) return i;
  }
  return -1;
}

function parseHabits(line) {
  const m = HABIT_RE.exec(line);
  const done = new Set();
  if (!m) return done;
  const re = /([✅⬜])([^✅⬜]*)/g;
  let x;
  while ((x = re.exec(m[1]))) {
    const name = x[2].trim();
    if (name && x[1] === '✅') done.add(name);
  }
  return done;
}

function formatHabits(habits, done) {
  return '习惯：' + habits.map(h => (done.has(h) ? '✅' : '⬜') + h).join(' ');
}

function habitLineIndex(lines, range) {
  for (let i = range.start + 1; i < range.end; i++) {
    if (HABIT_RE.test(lines[i])) return i;
  }
  return -1;
}

function ensureDay(lines, day) {
  const exist = dayRange(lines, day);
  if (exist) return exist;
  const heading = `## ${pad(day)}`;
  const below = listDays(lines).find(d => d.day < day);
  if (below) {
    lines.splice(below.start, 0, heading, '');
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (!lines.some(l => HR_RE.test(l))) lines.push('', '---');
    lines.push('', heading, '');
  }
  return dayRange(lines, day);
}

function insertTaskBlock(lines, range, block) {
  for (let i = range.start + 1; i < range.end; i++) {
    if (EMPTY_TASK_RE.test(lines[i])) {
      lines.splice(i, 1, ...block);
      return;
    }
  }
  let last = -1;
  for (let i = range.start + 1; i < range.end; i++) {
    if (TASK_RE.test(lines[i])) last = i + countChildren(lines, i, range.end);
  }
  if (last >= 0) {
    lines.splice(last + 1, 0, ...block);
    return;
  }
  let at = range.start + 1;
  while (at < range.end && (lines[at].trim() === '' || HABIT_RE.test(lines[at]))) at++;
  const ins = [...block];
  if (at < lines.length && lines[at].trim() !== '') ins.push('');
  if (at > 0 && HABIT_RE.test(lines[at - 1])) ins.unshift('');
  lines.splice(at, 0, ...ins);
}

function quadOf(t) {
  const important = t.y < 50;
  const urgent = t.x > 50;
  if (important && urgent) return 1;
  if (important) return 2;
  if (urgent) return 4;
  return 3;
}

function quadList(tasks, q) {
  return tasks
    .filter(t => t.x != null && quadOf(t) === q)
    .sort((a, b) => (a.done - b.done) || (a.y - b.y) || (a.x - b.x) || (a.line - b.line));
}

function spreadY(n, q) {
  const { lo, hi } = QUADS[q];
  return Array.from({ length: n }, (_, k) => Math.round(lo + (k + 1) * (hi - lo) / (n + 1)));
}

function endPos(tasks, q) {
  const { x, lo, hi } = QUADS[q];
  const ys = tasks.filter(t => t.x != null && quadOf(t) === q).map(t => t.y);
  const y = ys.length ? Math.min(hi, Math.round(Math.max(...ys)) + 2) : Math.round((lo + hi) / 2);
  return { x, y };
}

// 把 task 插到象限 q 的第 index 位，返回需要改坐标的 [{ task, patch }]
function reorderPatches(tasks, task, q, index) {
  const list = tasks.filter(t => t.line !== task.line);
  list.splice(clamp(index, 0, list.length), 0, task);
  const ys = spreadY(list.length, q);
  const out = [];
  list.forEach((t, k) => {
    const inQuad = t.x != null && quadOf(t) === q;
    const x = t === task && !inQuad ? QUADS[q].x : t.x;
    if (t.x !== x || t.y !== ys[k]) out.push({ task: t, patch: { x, y: ys[k] } });
  });
  return out;
}

// ---------- 星空 ----------

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKY_BOX = { x0: 6, x1: 94, y0: 8, y1: 92 };

// 已完成的每日任务 → 所在象限里的星星。位置由「日期|文本|第几个同名」哈希决定，
// 只避开更早日子的星星，所以今天再完成任务也不会挪动已有的星星。
function skyLayout(tasks, periodTasks, viewDay) {
  const done = tasks
    .filter(t => t.done && t.x != null && t.day != null && t.day <= viewDay)
    .sort((a, b) => a.day - b.day || a.line - b.line);
  const seen = new Map();
  const placed = { 1: [], 2: [], 3: [], 4: [] };
  const stars = [];
  const r2 = v => Math.round(v * 100) / 100;
  for (const t of done) {
    const base = `${t.day}|${t.text}`;
    const dup = seen.get(base) || 0;
    seen.set(base, dup + 1);
    const key = `${base}|${dup}`;
    const q = quadOf(t);
    const rand = rng(hashStr(key));
    const older = placed[q].filter(s => s.day < t.day);
    let best = null;
    let bestD = -1;
    for (let i = 0; i < 6; i++) {
      const x = SKY_BOX.x0 + rand() * (SKY_BOX.x1 - SKY_BOX.x0);
      const y = SKY_BOX.y0 + rand() * (SKY_BOX.y1 - SKY_BOX.y0);
      let d = Infinity;
      for (const s of older) d = Math.min(d, Math.hypot((x - s.x) * 1.4, y - s.y));
      if (d > bestD) {
        bestD = d;
        best = { x, y };
      }
    }
    const p = t.parent ? periodTasks.find(x => x.id === t.parent) : null;
    const star = {
      key,
      raw: t.raw,
      q,
      day: t.day,
      x: r2(best.x),
      y: r2(best.y),
      level: p ? p.level : 0,
      parent: p ? p.id : '',
      name: p ? p.text : '',
      today: t.day === viewDay,
      age: viewDay - t.day,
    };
    placed[q].push(star);
    stars.push(star);
  }
  const groups = new Map();
  for (const s of stars) {
    if (!s.parent) continue;
    const k = `${s.q}|${s.parent}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const lines = [...groups.values()]
    .filter(g => g.length >= 2)
    .map(g => ({ q: g[0].q, parent: g[0].parent, pts: g.map(s => [s.x, s.y]) }));
  return { stars, lines };
}

// 背景里的微尘星，只是装饰
function dustLayout(seed, n) {
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: Math.round(rand() * 1000) / 10,
      y: Math.round(rand() * 1000) / 10,
      o: Math.round((0.15 + rand() * 0.4) * 100) / 100,
      d: Math.round(rand() * 60) / 10,
      big: rand() < 0.2,
    });
  }
  return out;
}

// 「马上做」的火势：0 熄灭，1–3 越来越旺
function heatOf(tasks, periodTasks) {
  const open = quadList(tasks, 1).filter(t => !t.done);
  if (!open.length) return { level: 0, n: 0, soon: false };
  const soon = open.some(t => {
    const p = t.parent ? periodTasks.find(x => x.id === t.parent) : null;
    const due = t.due || (p && p.due);
    return !!due && daysUntil(due) <= 1;
  });
  return { level: clamp(Math.ceil(open.length / 2) + (soon ? 1 : 0), 1, 3), n: open.length, soon };
}

function longestStreak(doneByDay, name, from, to) {
  let best = 0;
  let run = 0;
  for (let d = from; d <= to; d++) {
    run = (doneByDay.get(d) || new Set()).has(name) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function periodStats(o) {
  const { periodTasks, allDaily, habitByDay, habits, start, end, day } = o;
  const to = Math.min(day, end);
  let checkins = 0;
  for (const [d, set] of habitByDay) if (d >= start && d <= to) checkins += set.size;
  let best = { name: '', n: 0 };
  for (const h of habits) {
    const n = longestStreak(habitByDay, h, start, to);
    if (n > best.n) best = { name: h, n };
  }
  return {
    periodDone: periodTasks.filter(t => t.done).length,
    periodTotal: periodTasks.length,
    dailyDone: allDaily.filter(t => t.done).length,
    dailyTotal: allDaily.length,
    checkins,
    best,
    nth: clamp(day - start + 1, 1, end - start + 1),
    total: end - start + 1,
  };
}

function habitStreak(doneByDay, name, day, firstDay) {
  let d = day;
  if (!(doneByDay.get(d) || new Set()).has(name)) d -= 1;
  let n = 0;
  while (d >= firstDay && (doneByDay.get(d) || new Set()).has(name)) {
    n++;
    d--;
  }
  return n;
}

function parsePeriod(file) {
  const m = PERIOD_RE.exec(file.path);
  if (!m) return null;
  const year = +m[1];
  const month = +m[2];
  const start = +m[3];
  const end = +m[4];
  if (month < 1 || month > 12 || start < 1 || end < start) return null;
  const startDate = moment({ year, month: month - 1, date: 1 });
  const last = startDate.daysInMonth();
  if (start > last) return null;
  startDate.date(start);
  const endDate = startDate.clone().date(Math.min(end, last));
  return {
    file,
    year,
    month,
    start,
    end,
    startDate,
    endDate,
    label: `${year}/${pad(month)} ${start}-${end}`,
  };
}

function defaultEnd(start) {
  const last = start.daysInMonth();
  const d = start.date();
  for (const c of [10, 20, last]) {
    if (c >= d + 5) return start.clone().date(c);
  }
  return start.clone().date(last);
}

function daysUntil(due) {
  return moment(due, 'YYYY-MM-DD').diff(moment().startOf('day'), 'days');
}

function countdown(due) {
  const n = daysUntil(due);
  const d = moment(due, 'YYYY-MM-DD');
  const md = `${d.month() + 1}/${d.date()}`;
  if (n < 0) return { text: `${md} · 已过期 ${-n} 天`, short: `过期 ${-n} 天`, cls: 'is-over' };
  if (n === 0) return { text: `${md} · 今天截止`, short: '今天截止', cls: 'is-over' };
  if (n === 1) return { text: `${md} · 明天截止`, short: '明天截止', cls: 'is-over' };
  if (n <= 3) return { text: `${md} · 剩 ${n} 天`, short: `剩 ${n} 天`, cls: 'is-soon' };
  return { text: `${md} · 剩 ${n} 天`, short: `剩 ${n} 天`, cls: '' };
}

function slotHasHour(slot, hour) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(slot);
  return !!m && hour >= +m[1] && hour < +m[2];
}

function renderMd(app, md, el, path, comp) {
  if (typeof MarkdownRenderer.render === 'function') {
    return MarkdownRenderer.render(app, md, el, path, comp);
  }
  return MarkdownRenderer.renderMarkdown(md, el, path, comp);
}

// ---------- 界面小部件 ----------

function applySkin(el, plugin) {
  const t = plugin.settings.theme;
  const dark = t === 'dark' || (t === 'auto' && document.body.classList.contains('theme-dark'));
  el.classList.add('pm-skin');
  el.classList.remove('pm-dark', 'pm-light');
  el.classList.add(dark ? 'pm-dark' : 'pm-light');
  el.style.fontSize = (SIZES[plugin.settings.size] || SIZES.m) + 'px';
  el.classList.toggle('pm-fx', !!plugin.settings.fx);
}

function iconBtn(parent, icon, label, cls) {
  const b = parent.createEl('button', { cls: 'pm-iconbtn' + (cls ? ' ' + cls : ''), attr: { 'aria-label': label } });
  setIcon(b, icon);
  return b;
}

function textBtn(parent, text, cls, icon) {
  const b = parent.createEl('button', { cls: 'pm-btn' + (cls ? ' ' + cls : '') });
  if (icon) setIcon(b.createSpan('pm-btn-icon'), icon);
  b.createSpan({ text });
  return b;
}

function buildCheck(parent, done, onToggle) {
  const c = parent.createDiv({ cls: 'pm-check' + (done ? ' is-on' : ''), attr: { role: 'checkbox', 'aria-checked': String(done) } });
  setIcon(c, 'check');
  c.addEventListener('click', e => {
    e.stopPropagation();
    onToggle(!done, c);
  });
  return c;
}

function buildStars(parent, level, onChange, extra) {
  const box = parent.createDiv('pm-stars' + (extra ? ' ' + extra : '') + (level ? '' : ' is-empty'));
  box.setAttr('aria-label', LEVEL_NAMES[level]);
  const stars = [];
  for (let i = 1; i <= 3; i++) {
    const s = box.createSpan({ cls: 'pm-star' + (i <= level ? ' is-on' : ''), text: '★' });
    s.addEventListener('mouseenter', () => stars.forEach((x, k) => x.toggleClass('is-hover', k < i)));
    s.addEventListener('click', e => {
      e.stopPropagation();
      onChange(i === level ? 0 : i);
    });
    stars.push(s);
  }
  box.addEventListener('mouseleave', () => stars.forEach(x => x.removeClass('is-hover')));
  return box;
}

function buildDatePicker(parent, opts) {
  const today = moment().startOf('day');
  const wrap = parent.createDiv('pm-dp');
  let value = opts.value || '';
  let open = false;
  let view = (value ? moment(value, 'YYYY-MM-DD') : today.clone()).startOf('month');

  let quick = opts.quick;
  if (!quick) {
    const fri = today.clone().isoWeekday(5);
    if (!fri.isAfter(today, 'day')) fri.add(1, 'week');
    quick = [
      ['今天', today.clone()],
      ['明天', today.clone().add(1, 'day')],
      ['周五', fri],
      ['下周一', today.clone().isoWeekday(8)],
      ['一周后', today.clone().add(7, 'day')],
    ];
    if (opts.periodEnd && opts.periodEnd.isSameOrAfter(today, 'day')) quick.push(['本期结束', opts.periodEnd.clone()]);
  }

  const field = wrap.createDiv('pm-dp-field');
  const chips = wrap.createDiv('pm-dp-chips');
  const cal = wrap.createDiv('pm-dp-cal');

  const set = v => {
    value = v;
    if (v) view = moment(v, 'YYYY-MM-DD').startOf('month');
    opts.onChange(v);
    draw();
  };

  function draw() {
    field.empty();
    setIcon(field.createSpan('pm-dp-icon'), 'calendar');
    if (value) {
      const d = moment(value, 'YYYY-MM-DD');
      field.createSpan({ cls: 'pm-dp-value', text: `${d.year()}年${d.month() + 1}月${d.date()}日 周${WEEK[d.day()]}` });
      if (!opts.noCountdown) {
        const c = countdown(value);
        field.createSpan({ cls: `pm-pill ${c.cls}`, text: c.short });
      }
    } else {
      field.createSpan({ cls: 'pm-dp-placeholder', text: opts.placeholder || '不设截止日期' });
    }
    field.createDiv('pm-spacer');
    setIcon(field.createSpan('pm-dp-caret'), open ? 'chevron-up' : 'chevron-down');

    chips.empty();
    for (const [label, d] of quick) {
      const v = d.format('YYYY-MM-DD');
      const b = chips.createEl('button', { cls: 'pm-chipbtn' + (v === value ? ' is-on' : ''), text: label });
      b.onclick = e => {
        e.preventDefault();
        open = false;
        set(v);
      };
    }
    if (value && opts.clearable !== false) {
      const b = chips.createEl('button', { cls: 'pm-chipbtn is-clear', text: '清除' });
      b.onclick = e => {
        e.preventDefault();
        set('');
      };
    }

    cal.empty();
    cal.toggleClass('is-open', open);
    if (!open) return;
    const head = cal.createDiv('pm-dp-head');
    iconBtn(head, 'chevron-left', '上个月').onclick = e => {
      e.preventDefault();
      view.subtract(1, 'month');
      draw();
    };
    head.createSpan({ cls: 'pm-dp-month', text: `${view.year()}年${view.month() + 1}月` });
    iconBtn(head, 'chevron-right', '下个月').onclick = e => {
      e.preventDefault();
      view.add(1, 'month');
      draw();
    };
    const grid = cal.createDiv('pm-dp-grid');
    for (const w of ['一', '二', '三', '四', '五', '六', '日']) grid.createDiv({ cls: 'pm-dp-wd', text: w });
    for (let i = 1; i < view.isoWeekday(); i++) grid.createDiv('pm-dp-blank');
    for (let d = 1; d <= view.daysInMonth(); d++) {
      const m = view.clone().date(d);
      const v = m.format('YYYY-MM-DD');
      const cell = grid.createEl('button', { cls: 'pm-dp-day', text: String(d) });
      if (v === value) cell.addClass('is-sel');
      if (m.isSame(today, 'day')) cell.addClass('is-today');
      if (m.isBefore(today, 'day')) cell.addClass('is-past');
      if (opts.periodEnd && m.isSame(opts.periodEnd, 'day')) {
        cell.addClass('is-pend');
        cell.title = '本期最后一天';
      }
      cell.onclick = e => {
        e.preventDefault();
        open = false;
        set(v);
      };
    }
  }

  field.onclick = () => {
    open = !open;
    if (open) view = (value ? moment(value, 'YYYY-MM-DD') : today.clone()).startOf('month');
    draw();
  };
  draw();
  return {
    setValue(v) {
      value = v;
      if (v) view = moment(v, 'YYYY-MM-DD').startOf('month');
      draw();
    },
  };
}

// ---------- 插件 ----------

class WorkmapPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.carrying = false;
    this.history = [];

    this.registerView(VIEW_TYPE, leaf => new MatrixView(leaf, this));
    this.addRibbonIcon('layout-grid', '打开 Workmap', () => this.activateView());
    this.addCommand({ id: 'open', name: '打开 Workmap', callback: () => this.activateView() });
    this.addCommand({ id: 'new-period', name: '新建下一期时段笔记', callback: () => this.openNewPeriodModal() });
    this.addCommand({ id: 'today-section', name: '跳到今天的小节', callback: () => this.gotoToday() });
    this.addCommand({ id: 'edit-habits', name: '编辑每日习惯', callback: () => new HabitModal(this).open() });
    this.addCommand({ id: 'undo', name: '撤销上一步操作', callback: () => this.undo() });
    this.registerObsidianProtocolHandler('workmap', () => this.activateView());
    if (editorExt) this.registerEditorExtension(editorExt);
    this.addSettingTab(new MatrixSettingTab(this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshViews();
  }

  periods() {
    return this.app.vault
      .getMarkdownFiles()
      .map(parsePeriod)
      .filter(Boolean)
      .sort((a, b) => b.startDate.valueOf() - a.startDate.valueOf());
  }

  periodFor(date) {
    return this.periods().find(
      p => !date.isBefore(p.startDate, 'day') && !date.isAfter(p.endDate, 'day'),
    ) || null;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      leaf.view.requestRefresh();
    }
  }

  async openFileAtLine(file, line) {
    const { workspace } = this.app;
    let leaf = workspace
      .getLeavesOfType('markdown')
      .find(l => l.view.file && l.view.file.path === file.path);
    if (!leaf) leaf = workspace.getLeaf('split', 'vertical');
    await leaf.openFile(file, { active: true, eState: { line } });
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  // ----- 写回 md -----

  async mutate(file, fn, record = true) {
    let result = true;
    let before = null;
    let after = null;
    await this.app.vault.process(file, data => {
      const { lines, eol } = splitLines(data);
      const r = fn(lines);
      if (r === false) {
        result = false;
        return data;
      }
      before = data;
      after = lines.join(eol);
      return after;
    });
    if (result && record && before !== after) {
      this.history.push({ file, before, after });
      if (this.history.length > 30) this.history.shift();
    }
    return result;
  }

  async undo() {
    const h = this.history.pop();
    if (!h) {
      new Notice('没有可以撤销的操作');
      return false;
    }
    let ok = false;
    await this.app.vault.process(h.file, data => {
      if (data !== h.after) return data;
      ok = true;
      return h.before;
    });
    if (!ok) {
      this.history = [];
      new Notice('笔记在别处改过了，无法撤销');
    }
    return ok;
  }

  async updateMany(file, scope, items) {
    if (!items.length) return true;
    const ok = await this.mutate(file, lines => {
      const r = rangeOf(lines, scope);
      if (!r) return false;
      const used = new Set();
      for (const { task, patch } of items) {
        let idx = -1;
        for (let i = r.start + 1; i < r.end; i++) {
          if (lines[i] === task.raw && !used.has(i)) {
            idx = i;
            break;
          }
        }
        if (idx < 0) return false;
        used.add(idx);
        lines[idx] = formatTask(Object.assign({}, task, patch));
      }
    });
    if (!ok) {
      new Notice('笔记内容刚刚变化过，已刷新，请再操作一次');
      this.refreshViews();
    }
    return ok;
  }

  async updateTask(file, scope, task, patch) {
    const ok = await this.mutate(file, lines => {
      const r = rangeOf(lines, scope);
      const idx = r ? findRaw(lines, r, task.raw) : -1;
      if (idx < 0) return false;
      const kids = countChildren(lines, idx, r.end);
      if (patch === null) {
        lines.splice(idx, 1 + kids);
      } else if (patch.note !== undefined) {
        lines.splice(idx, 1 + kids, ...taskBlock(Object.assign({}, task, patch)));
      } else {
        lines[idx] = formatTask(Object.assign({}, task, patch));
      }
    });
    if (!ok) {
      new Notice('笔记内容刚刚变化过，已刷新，请再操作一次');
      this.refreshViews();
    }
    return ok;
  }

  async addPeriodTask(file, task) {
    await this.mutate(file, lines => {
      let r = periodRange(lines);
      if (!r) {
        lines.unshift('## 周期任务', '');
        r = periodRange(lines);
      }
      let at = r.start;
      for (let i = r.start; i < r.end; i++) {
        if (lines[i].trim()) at = i;
      }
      const block = taskBlock(task);
      lines.splice(at + 1, 0, ...(at === r.start ? ['', ...block] : block));
    });
  }

  async addDayTask(file, day, task) {
    await this.mutate(file, lines => {
      insertTaskBlock(lines, ensureDay(lines, day), taskBlock(task));
    });
  }

  async ensurePeriodId(file, task) {
    if (task.id) return task.id;
    const id = newId();
    const ok = await this.updateTask(file, { kind: 'period' }, task, { id });
    return ok ? id : null;
  }

  async toggleHabit(file, day, name) {
    const habits = this.settings.habits;
    await this.mutate(file, lines => {
      const r = ensureDay(lines, day);
      const idx = habitLineIndex(lines, r);
      const done = idx >= 0 ? parseHabits(lines[idx]) : new Set();
      if (done.has(name)) done.delete(name);
      else done.add(name);
      const line = formatHabits(habits, done);
      if (idx >= 0) lines[idx] = line;
      else lines.splice(r.start + 1, 0, '', line);
    });
  }

  async addSection(file) {
    await this.mutate(file, lines => {
      if (periodRange(lines)) return false;
      lines.unshift('[🧭 打开 Workmap](obsidian://workmap)', '', '## 周期任务', '');
    });
  }

  // ----- 自动顺延 -----

  async carryOver(today) {
    if (this.carrying) return 0;
    this.carrying = true;
    try {
      const cur = this.periodFor(today);
      if (!cur) return 0;
      const prev = this.periods().find(p => p.endDate.isBefore(cur.startDate, 'day'));

      const pick = async p => {
        const { lines } = splitLines(await this.app.vault.read(p.file));
        const out = [];
        for (const d of listDays(lines)) {
          if (d.day > p.startDate.daysInMonth()) continue;
          const date = p.startDate.clone().date(d.day);
          if (!date.isBefore(today, 'day')) continue;
          for (let i = d.start + 1; i < d.end; i++) {
            const t = parseTaskLine(lines[i], i);
            if (!t || t.done || !t.text) continue;
            const kids = countChildren(lines, i, d.end);
            const block = [formatTask(Object.assign({}, t, { slot: '' })), ...lines.slice(i + 1, i + 1 + kids)];
            out.push({
              day: d.day,
              raw: lines[i],
              block,
              info: { raw: block[0], text: t.text, from: `${p.month}/${d.day}` },
            });
          }
        }
        return out;
      };
      const mark = (lines, items) => {
        for (const it of items) {
          const r = dayRange(lines, it.day);
          const idx = r ? findRaw(lines, r, it.raw) : -1;
          if (idx >= 0) lines[idx] = lines[idx].replace('- [ ]', '- [>]');
        }
      };

      const fromPrev = prev ? await pick(prev) : [];
      const fromCur = await pick(cur);
      const total = fromPrev.length + fromCur.length;
      if (!total) return 0;

      await this.mutate(cur.file, lines => {
        mark(lines, fromCur);
        const r = ensureDay(lines, today.date());
        insertTaskBlock(lines, r, [...fromPrev, ...fromCur].flatMap(it => it.block));
      }, false);
      if (fromPrev.length) await this.mutate(prev.file, lines => mark(lines, fromPrev), false);

      const date = today.format('YYYY-MM-DD');
      const old = this.settings.carry && this.settings.carry.date === date ? this.settings.carry.items : [];
      this.settings.carry = {
        date,
        dismissed: false,
        items: [...old, ...[...fromPrev, ...fromCur].map(it => it.info)],
      };
      await this.saveData(this.settings);
      return total;
    } finally {
      this.carrying = false;
    }
  }

  // ----- 新建时段笔记 -----

  openNewPeriodModal() {
    const today = moment().startOf('day');
    const cur = this.periodFor(today);
    const start = cur ? cur.endDate.clone().add(1, 'day') : today.clone();
    new NewPeriodModal(this, start, defaultEnd(start)).open();
  }

  async loadTemplate() {
    const f = this.app.vault.getAbstractFileByPath(TEMPLATE_PATH);
    if (f instanceof TFile) return this.app.vault.read(f);
    return DEFAULT_TEMPLATE;
  }

  async createPeriod(start, end, migrate) {
    const { vault } = this.app;
    if (start.year() !== end.year() || start.month() !== end.month()) {
      new Notice('开始和结束日期需要在同一个月');
      return null;
    }
    if (end.isBefore(start, 'day')) {
      new Notice('结束日期不能早于开始日期');
      return null;
    }
    const clash = this.periods().find(
      p => !(end.isBefore(p.startDate, 'day') || start.isAfter(p.endDate, 'day')),
    );
    if (clash) {
      new Notice(`和已有的 ${clash.file.path} 日期重叠`);
      return null;
    }

    const folder = `${start.year()}/${pad(start.month() + 1)}`;
    const path = `${folder}/${start.date()}-${end.date()}.md`;

    let moved = [];
    let source = null;
    if (migrate) {
      source = this.periods().find(p => p.startDate.isBefore(start, 'day'));
      if (source) {
        const { lines } = splitLines(await vault.read(source.file));
        const r = periodRange(lines);
        if (r) {
          moved = collectTasks(lines, r, 'period')
            .filter(t => !t.done)
            .map(t => ({ raw: t.raw, block: [formatTask(t), ...lines.slice(t.line + 1, t.line + 1 + t.children)] }));
        }
      }
    }

    const today = moment().startOf('day');
    const inRange = !today.isBefore(start, 'day') && !today.isAfter(end, 'day');
    const day = pad(inRange ? today.date() : start.date());
    const content = (await this.loadTemplate())
      .split('{{tasks}}').join(moved.map(m => m.block.join('\n')).join('\n'))
      .split('{{day}}').join(day);

    if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    const file = await vault.create(path, content);

    if (source && moved.length) {
      await this.mutate(source.file, lines => {
        for (const m of moved) {
          const r = periodRange(lines);
          const idx = r ? findRaw(lines, r, m.raw) : -1;
          if (idx >= 0) lines.splice(idx, 1 + countChildren(lines, idx, r.end));
        }
      });
    }
    new Notice(`已创建 ${path}` + (moved.length ? `，从 ${source.label} 迁移了 ${moved.length} 个周期任务` : ''));
    return file;
  }

  async gotoToday() {
    const today = moment();
    const p = this.periodFor(today);
    if (!p) {
      new Notice('今天还没有对应的时段笔记，先新建一期');
      this.openNewPeriodModal();
      return;
    }
    let line = 0;
    await this.mutate(p.file, lines => {
      line = ensureDay(lines, today.date()).start;
    }, false);
    await this.openFileAtLine(p.file, line);
  }
}

// ---------- 视图 ----------

class MatrixView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.follow = true;
    this.selectedPath = null;
    this.dayDate = null;
    this.period = null;
    this.file = null;
    this.day = null;
    this.periodTasks = [];
    this.allDaily = [];
    this.dayTasks = [];
    this.habitsDone = new Set();
    this.habitCounts = new Map();
    this.habitByDay = new Map();
    this.carried = new Set();
    this.carryOpen = false;
    this.dragging = false;
    this.justDragged = false;
    this.busy = false;
    this.again = false;
    this.draft = '';
    this.lastQuad = '1';
    this.lastParent = '';
    this.focusInput = false;
    this.selectQuad = null;
    this.renderComp = null;
    this.timer = null;
    this.toastEl = null;
    this.toastTimer = null;
    this.fxEl = null;
    this.pop = null;
    this.popHit = false;
    this.stats = null;
    this.heatKey = '';
    this.heatLevel = 0;
    this.smokeUntil = 0;
    this.smokeFresh = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Workmap';
  }

  getIcon() {
    return 'layout-grid';
  }

  get settings() {
    return this.plugin.settings;
  }

  async onOpen() {
    this.contentEl.addClass('pm-view');
    this.containerEl.addClass('pm-host');
    this.registerEvent(this.app.vault.on('modify', f => {
      if (this.file && f.path === this.file.path) this.requestRefresh();
    }));
    for (const ev of ['create', 'delete', 'rename']) {
      this.registerEvent(this.app.vault.on(ev, () => this.requestRefresh()));
    }
    this.registerEvent(this.app.workspace.on('css-change', () => this.requestRefresh()));
    this.registerInterval(window.setInterval(() => this.requestRefresh(), 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.meteor(), 9000));
    this.registerDomEvent(document, 'keydown', e => {
      if (this.app.workspace.getActiveViewOfType(MatrixView) !== this) return;
      if (e.target.closest && e.target.closest('input, textarea, select, .modal')) return;
      if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      }
    });
    await this.refresh();
  }

  async onClose() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.toastTimer);
    if (this.toastEl) this.toastEl.remove();
    if (this.fxEl) this.fxEl.remove();
  }

  requestRefresh() {
    if (this.dragging) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 150);
  }

  async refresh() {
    if (this.dragging) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      await this.render();
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        this.requestRefresh();
      }
    }
  }

  dayScope() {
    return { kind: 'day', day: this.day.date() };
  }

  // ----- 撤销提示 -----

  toast(text, undoable = true) {
    window.clearTimeout(this.toastTimer);
    if (this.toastEl) this.toastEl.remove();
    const t = this.containerEl.createDiv('pm-toast');
    applySkin(t, this.plugin);
    t.createSpan({ cls: 'pm-toast-text', text });
    if (undoable) {
      const b = t.createEl('button', { cls: 'pm-toast-btn', text: '撤销' });
      b.onclick = () => this.undo();
    }
    this.toastEl = t;
    window.requestAnimationFrame(() => t.addClass('is-show'));
    this.toastTimer = window.setTimeout(() => this.hideToast(), 5000);
  }

  hideToast() {
    const t = this.toastEl;
    if (!t) return;
    this.toastEl = null;
    t.removeClass('is-show');
    window.setTimeout(() => t.remove(), 250);
  }

  async undo() {
    this.hideToast();
    if (await this.plugin.undo()) this.toast('已撤销', false);
  }

  async remove(scope, t, label) {
    if (await this.plugin.updateTask(this.file, scope, t, null)) this.toast(`已删除「${label || t.text}」`);
  }

  async setDone(scope, t, v, el) {
    const fx = this.fxOn();
    let allDay = false;
    let lastPeriod = false;
    if (v) {
      if (scope.kind === 'day') {
        allDay = this.dayTasks.length >= 2 && this.dayTasks.every(x => x === t || x.done);
      } else {
        lastPeriod = this.periodTasks.length >= 1 && this.periodTasks.every(x => x === t || x.done);
      }
      this.pop = { raw: formatTask(Object.assign({}, t, { done: true })), until: Date.now() + 2000 };
      if (scope.kind === 'day' && el) this.pop.from = el.getBoundingClientRect();
      if (fx && el) {
        el.addClass('is-on');
        el.addClass('is-pop');
        this.burst(el);
      }
    }
    if (!v) {
      await this.plugin.updateTask(this.file, scope, t, { done: v });
      return;
    }
    if (lastPeriod) this.stats = { played: !fx };
    if (!await this.plugin.updateTask(this.file, scope, t, { done: v })) {
      this.stats = null;
      return;
    }
    if (lastPeriod) {
      if (fx) this.confetti(true);
      this.toast('本期周期任务全部完成！');
    } else if (allDay) {
      if (fx) this.confetti(false);
      this.toast('今天的任务全部完成 🎉');
    } else {
      this.toast(`已完成「${t.text}」`);
    }
  }

  // ----- 趣味动画 -----

  fxOn() {
    return !!this.settings.fx && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  fxLayer() {
    if (!this.fxEl || !this.fxEl.isConnected) this.fxEl = document.body.createDiv('pm-fx-layer');
    return this.fxEl;
  }

  burst(el) {
    const r = el.getBoundingClientRect();
    const color = getComputedStyle(el).getPropertyValue('--pm-check').trim() || '#34c759';
    const layer = this.fxLayer();
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const d = r.width * (0.9 + Math.random() * 0.8);
      const p = layer.createDiv('pm-spark');
      p.style.left = (r.left + r.width / 2) + 'px';
      p.style.top = (r.top + r.height / 2) + 'px';
      p.style.background = color;
      p.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px');
      p.style.setProperty('--dy', (Math.sin(a) * d).toFixed(1) + 'px');
      p.addEventListener('animationend', () => p.remove());
    }
  }

  confetti(big) {
    const r = this.contentEl.getBoundingClientRect();
    const box = this.fxLayer().createDiv('pm-confetti-box');
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    const colors = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#5ac8fa', '#007aff', '#af52de', '#ff2d55'];
    const n = big ? 120 : 70;
    for (let i = 0; i < n; i++) {
      const c = box.createDiv('pm-confetti');
      c.style.left = (Math.random() * 100) + '%';
      c.style.width = (5 + Math.random() * 5) + 'px';
      c.style.height = (8 + Math.random() * 7) + 'px';
      c.style.background = colors[i % colors.length];
      if (Math.random() < 0.3) c.style.borderRadius = '999px';
      c.style.setProperty('--dx', ((Math.random() - 0.5) * 220).toFixed(0) + 'px');
      c.style.setProperty('--dy', (r.height * (0.55 + Math.random() * 0.5)).toFixed(0) + 'px');
      c.style.setProperty('--rot', ((Math.random() - 0.5) * 1080).toFixed(0) + 'deg');
      c.style.animationDuration = (1.8 + Math.random() * 1.4).toFixed(2) + 's';
      c.style.animationDelay = (Math.random() * (big ? 0.6 : 0.3)).toFixed(2) + 's';
    }
    window.setTimeout(() => box.remove(), 4000);
  }

  popMatch(t) {
    if (!this.pop || this.pop.raw !== t.raw || Date.now() > this.pop.until || !this.fxOn()) return false;
    this.popHit = true;
    return true;
  }

  replayPop(chk, card) {
    chk.addClass('is-settle');
    card.addClass('is-justdone');
  }

  // 显示用的「今天」在本期里是第几日（本期没开始取开始日，已结束取结束日）
  statDay() {
    const p = this.period;
    const today = moment().startOf('day');
    if (today.isBefore(p.startDate, 'day')) return p.start;
    if (today.isAfter(p.endDate, 'day')) return p.endDate.date();
    return today.date();
  }

  buildStatsCard(grid) {
    const p = this.period;
    const s = periodStats({
      periodTasks: this.periodTasks,
      allDaily: this.allDaily,
      habitByDay: this.habitByDay,
      habits: this.settings.habits,
      start: p.start,
      end: p.endDate.date(),
      day: this.statDay(),
    });
    const card = grid.createDiv('pm-pcard pm-stats');
    if (this.stats && !this.stats.played) {
      card.addClass('is-flip');
      this.stats.played = true;
    }
    const head = card.createDiv('pm-stats-head');
    setIcon(head.createSpan('pm-stats-icon'), 'trophy');
    const ht = head.createDiv();
    ht.createDiv({ cls: 'pm-stats-title', text: '本期主线全部完成' });
    const left = s.total - s.nth;
    ht.createDiv({
      cls: 'pm-stats-sub',
      text: left > 0 ? `第 ${s.nth} 天完成 · 提前 ${left} 天` : `共 ${s.total} 天`,
    });
    const g = card.createDiv('pm-stats-grid');
    const cell = (num, label) => {
      const c = g.createDiv('pm-stats-cell');
      c.createDiv({ cls: 'pm-stats-num', text: num });
      c.createDiv({ cls: 'pm-stats-label', text: label });
    };
    cell(String(s.periodDone), '条主线');
    cell(`${s.dailyDone}/${s.dailyTotal}`, '每日任务');
    cell(String(s.checkins), '次习惯打卡');
    cell(s.best.n ? `${s.best.n} 天` : '—', s.best.n ? `最长连续 · ${s.best.name}` : '最长连续');
  }

  // 「马上做」的火苗：图标随火势变化，清空时冒烟
  buildFlame(head, qd) {
    const icon = head.createSpan('pm-qicon pm-flame');
    setIcon(icon, QUADS[1].icon);
    const heat = heatOf(this.dayTasks, this.periodTasks);
    const key = `${this.file.path}#${this.day.date()}`;
    if (key === this.heatKey && this.heatLevel > 0 && heat.level === 0 && this.fxOn()) {
      this.smokeUntil = Date.now() + 4000;
      this.smokeFresh = true;
    }
    if (key !== this.heatKey) this.smokeUntil = 0;
    this.heatKey = key;
    this.heatLevel = heat.level;

    qd.dataset.heat = String(heat.level);
    icon.dataset.heat = String(heat.level);
    icon.title = heat.level
      ? `还有 ${heat.n} 项要马上做` + (heat.soon ? '，有任务今明两天截止' : '')
      : '火已经灭了';
    for (let i = 0; i < Math.max(0, heat.level - 1) * 2; i++) {
      const e = icon.createSpan('pm-ember');
      e.style.setProperty('--i', String(i));
    }
    const out = heat.level === 0 && Date.now() < this.smokeUntil;
    if (out) {
      icon.addClass('is-out');
      if (this.smokeFresh) {
        this.smokeFresh = false;
        for (let i = 0; i < 3; i++) {
          const s = icon.createSpan('pm-smoke');
          s.style.setProperty('--i', String(i));
        }
      }
    }
    return out;
  }

  // ----- 渲染 -----

  async render() {
    const today = moment().startOf('day');
    const periods = this.plugin.periods();
    if (this.follow) {
      this.period = this.plugin.periodFor(today);
    } else {
      this.period = periods.find(p => p.file.path === this.selectedPath) || null;
      if (!this.period) {
        this.follow = true;
        this.dayDate = null;
        this.period = this.plugin.periodFor(today);
      }
    }
    this.file = this.period ? this.period.file : null;

    this.day = null;
    if (this.period) {
      const inRange = d => !d.isBefore(this.period.startDate, 'day') && !d.isAfter(this.period.endDate, 'day');
      if (this.dayDate && inRange(this.dayDate)) this.day = this.dayDate.clone();
      else this.day = inRange(today) ? today.clone() : this.period.startDate.clone();
    }

    if (this.period && this.follow && this.day.isSame(today, 'day')) {
      const moved = await this.plugin.carryOver(today);
      if (moved) {
        this.again = true;
        return;
      }
    }

    let lines = null;
    if (this.file) lines = splitLines(await this.app.vault.read(this.file)).lines;

    const el = this.contentEl;
    const scroll = el.scrollTop;
    el.empty();
    applySkin(el, this.plugin);
    if (this.renderComp) this.removeChild(this.renderComp);
    this.renderComp = this.addChild(new Component());

    if (!this.file) {
      this.buildHero(el, periods, today);
      const box = el.createDiv('pm-empty');
      box.createDiv({ cls: 'pm-empty-title', text: '今天还没有对应的时段笔记' });
      box.createDiv({ cls: 'pm-empty-sub', text: '新建一期后，周期任务和每天的四象限都会出现在这里。' });
      textBtn(box, '新建这一期', 'is-primary', 'plus').onclick = () => this.plugin.openNewPeriodModal();
      return;
    }

    const pr = periodRange(lines);
    if (!pr) {
      this.buildHero(el, periods, today);
      const box = el.createDiv('pm-empty');
      box.createDiv({ cls: 'pm-empty-title', text: '这份笔记里还没有「## 周期任务」' });
      box.createDiv({ cls: 'pm-empty-sub', text: this.file.path });
      textBtn(box, '在笔记顶部添加', 'is-primary', 'plus').onclick = () => this.plugin.addSection(this.file);
      return;
    }

    this.periodTasks = collectTasks(lines, pr, 'period');
    const days = listDays(lines);
    this.allDaily = days.flatMap(d => collectTasks(lines, d, 'day').map(t => Object.assign(t, { day: d.day })));
    this.dayTasks = this.allDaily.filter(t => t.day === this.day.date());
    this.habitCounts = new Map();
    this.habitByDay = new Map();
    this.habitsDone = new Set();
    for (const d of days) {
      const idx = habitLineIndex(lines, d);
      if (idx < 0) continue;
      const done = parseHabits(lines[idx]);
      this.habitByDay.set(d.day, done);
      if (d.day === this.day.date()) this.habitsDone = done;
      for (const h of done) this.habitCounts.set(h, (this.habitCounts.get(h) || 0) + 1);
    }

    const carry = this.settings.carry;
    const showCarry = this.follow && this.day.isSame(today, 'day') && carry && carry.date === today.format('YYYY-MM-DD');
    this.carried = new Set(showCarry ? carry.items.map(i => i.raw) : []);

    this.buildHero(el, periods, today);
    if (showCarry && !carry.dismissed) this.buildCarry(el, carry);
    this.buildPeriodSection(el);
    this.buildHabits(el, today);
    this.buildDayHead(el, today);
    this.buildComposer(el);
    const main = el.createDiv('pm-main');
    this.buildBoard(main);
    this.buildTimeline(main, today);
    this.buildTray(el);
    if (!this.settings.hideTips) this.buildTips(el);
    el.scrollTop = scroll;
    this.flyPop();
    if (this.popHit) {
      this.pop = null;
      this.popHit = false;
    }
  }

  // ----- 顶部 -----

  buildHero(el, periods, today) {
    const hero = el.createDiv('pm-hero');
    const main = hero.createDiv('pm-hero-main');
    const day = this.day || today;
    const p = this.period;
    const isToday = day.isSame(today, 'day');

    main.createDiv({
      cls: 'pm-eyebrow',
      text: p ? `${p.year} · ${p.month}月 ${p.start}–${p.end}日` : `${today.year()} · 暂无时段`,
    });
    const row = main.createDiv('pm-title-row');
    row.createEl('h1', { cls: 'pm-title', text: `${day.month() + 1}月${day.date()}日` });
    row.createSpan({ cls: 'pm-weekday', text: `周${WEEK[day.day()]}` });
    if (isToday) row.createSpan({ cls: 'pm-badge', text: '今天' });

    if (p) {
      const total = p.endDate.diff(p.startDate, 'days') + 1;
      const nth = clamp(today.diff(p.startDate, 'days') + 1, 0, total);
      const prog = main.createDiv('pm-pprog');
      const track = prog.createDiv('pm-pprog-track');
      track.createDiv('pm-pprog-fill').style.width = (nth / total * 100) + '%';
      const sel = clamp(day.diff(p.startDate, 'days'), 0, total - 1);
      const mark = track.createDiv('pm-pprog-mark');
      mark.style.left = ((sel + 0.5) / total * 100) + '%';
      let text;
      if (today.isBefore(p.startDate, 'day')) text = `${p.startDate.diff(today, 'days')} 天后开始 · 共 ${total} 天`;
      else if (today.isAfter(p.endDate, 'day')) text = `本期已结束 · 共 ${total} 天`;
      else text = `第 ${nth} / ${total} 天 · 还剩 ${total - nth} 天`;
      prog.createSpan({ cls: 'pm-pprog-text', text });
    }

    const side = hero.createDiv('pm-hero-side');
    const nav = side.createDiv('pm-seg');
    const prevD = day.clone().subtract(1, 'day');
    const nextD = day.clone().add(1, 'day');
    const prev = iconBtn(nav, 'chevron-left', '前一天');
    prev.disabled = !this.plugin.periodFor(prevD);
    prev.onclick = () => this.goDay(prevD);
    if (!(isToday && this.follow)) {
      const tb = nav.createEl('button', { cls: 'pm-seg-mid', text: '回到今天' });
      tb.onclick = () => this.goDay(today);
    }
    const next = iconBtn(nav, 'chevron-right', '后一天');
    next.disabled = !this.plugin.periodFor(nextD);
    next.onclick = () => this.goDay(nextD);

    const sel = side.createEl('select', { cls: 'pm-select' });
    const cur = this.plugin.periodFor(today);
    sel.createEl('option', { value: '__today__', text: cur ? `本期 · ${cur.month}/${cur.start}–${cur.end}` : '本期 · 无' });
    for (const x of periods) {
      if (cur && x.file.path === cur.file.path) continue;
      sel.createEl('option', { value: x.file.path, text: `${x.year}/${x.month}/${x.start}–${x.end}` });
    }
    sel.value = this.follow || (cur && this.selectedPath === cur.file.path) ? '__today__' : this.selectedPath;
    sel.onchange = () => {
      this.follow = sel.value === '__today__';
      this.selectedPath = this.follow ? null : sel.value;
      this.dayDate = null;
      this.refresh();
    };

    const acts = side.createDiv('pm-actions');
    const open = iconBtn(acts, 'file-text', '打开笔记');
    open.disabled = !this.file;
    open.onclick = () => this.plugin.openFileAtLine(this.file, 0);
    textBtn(acts, '新建下一期', '', 'plus').onclick = () => this.plugin.openNewPeriodModal();
  }

  goDay(d) {
    const p = this.plugin.periodFor(d);
    if (!p) return;
    if (d.isSame(moment(), 'day')) {
      this.follow = true;
      this.selectedPath = null;
      this.dayDate = null;
    } else {
      this.follow = false;
      this.selectedPath = p.file.path;
      this.dayDate = d.clone();
    }
    this.refresh();
  }

  // ----- 顺延提示 -----

  buildCarry(el, carry) {
    const items = carry.items
      .map(i => Object.assign({}, i, { task: this.dayTasks.find(t => t.raw === i.raw) }))
      .filter(i => i.task);
    if (!items.length) return;
    const box = el.createDiv('pm-carry' + (this.carryOpen ? ' is-open' : ''));
    const head = box.createDiv('pm-carry-head');
    setIcon(head.createSpan('pm-carry-icon'), 'history');
    const txt = head.createDiv('pm-carry-text');
    txt.createSpan({ cls: 'pm-carry-title', text: `${items.length} 项没做完的任务顺延到了今天` });
    txt.createSpan({ cls: 'pm-carry-sub', text: items.slice(0, 3).map(i => i.text).join('、') + (items.length > 3 ? ' …' : '') });
    head.createDiv('pm-spacer');
    textBtn(head, this.carryOpen ? '收起' : '查看', 'is-ghost').onclick = () => {
      this.carryOpen = !this.carryOpen;
      this.refresh();
    };
    textBtn(head, '知道了', '').onclick = async () => {
      this.settings.carry.dismissed = true;
      this.carryOpen = false;
      await this.plugin.saveSettings();
    };
    if (!this.carryOpen) return;
    const list = box.createDiv('pm-carry-list');
    for (const i of items) {
      const row = list.createDiv('pm-carry-row');
      row.createSpan({ cls: 'pm-carry-from', text: i.from });
      row.createSpan({ cls: 'pm-carry-name', text: i.text });
      const acts = row.createDiv('pm-carry-acts');
      if (i.task.x != null) {
        iconBtn(acts, 'inbox', '放回待放置').onclick = () =>
          this.plugin.updateTask(this.file, this.dayScope(), i.task, { x: null, y: null });
      }
      iconBtn(acts, 'trash-2', '删除', 'is-danger').onclick = () => this.remove(this.dayScope(), i.task);
    }
  }

  // ----- 周期任务 -----

  buildPeriodSection(el) {
    const sec = el.createDiv('pm-section');
    const head = sec.createDiv('pm-section-head');
    head.createEl('h2', { cls: 'pm-h2', text: '周期任务' });
    const doneN = this.periodTasks.filter(t => t.done).length;
    head.createSpan({ cls: 'pm-count', text: `${doneN} / ${this.periodTasks.length} 完成` });
    head.createDiv('pm-spacer');
    textBtn(head, '新建', 'is-ghost', 'plus').onclick = () => this.newPeriodTask();

    const grid = sec.createDiv('pm-pgrid');
    if (this.periodTasks.length && this.periodTasks.every(t => t.done)) this.buildStatsCard(grid);
    else this.stats = null;
    const tasks = this.periodTasks
      .filter(t => !(this.settings.hideDone && t.done))
      .sort((a, b) =>
        (a.done - b.done)
        || (b.level - a.level)
        || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0));
    for (const t of tasks) grid.appendChild(this.makePeriodCard(t));
    if (!tasks.length && !this.periodTasks.length) {
      const add = grid.createDiv('pm-pcard is-add');
      add.createSpan({ text: '＋ 添加这一期要推进的主线' });
      add.onclick = () => this.newPeriodTask();
    }
  }

  newPeriodTask() {
    new TaskModal(this.plugin, {
      title: '新建周期任务',
      task: { text: '', level: 0, due: '', note: '' },
      fields: ['level', 'due', 'note'],
      periodEnd: this.period.endDate,
      onSave: patch => this.plugin.addPeriodTask(this.file, Object.assign({ done: false, id: newId() }, patch)),
    }).open();
  }

  makePeriodCard(t) {
    const card = createDiv({ cls: 'pm-pcard' });
    card.dataset.level = String(t.level);
    if (t.done) card.addClass('is-done');
    const scope = { kind: 'period' };
    const upd = patch => this.plugin.updateTask(this.file, scope, t, patch);

    const head = card.createDiv('pm-pcard-head');
    const chk = buildCheck(head, t.done, (v, el) => this.setDone(scope, t, v, el));
    if (this.popMatch(t)) this.replayPop(chk, card);
    buildStars(head, t.level, v => upd({ level: v }));
    head.createDiv('pm-spacer');
    if (t.due && !t.done) {
      const c = countdown(t.due);
      const pill = head.createSpan({ cls: `pm-pill ${c.cls}`, text: c.short });
      pill.title = c.text;
    }

    const title = card.createDiv('pm-pcard-title pm-text');
    renderMd(this.app, t.text, title, this.file.path, this.renderComp);
    this.bindLinks(title);

    if (t.note) {
      const note = card.createDiv('pm-pcard-note pm-text');
      renderMd(this.app, t.note, note, this.file.path, this.renderComp);
      this.bindLinks(note);
    }

    const linked = t.id ? this.allDaily.filter(d => d.parent === t.id) : [];
    const doneN = linked.filter(d => d.done).length;
    const todayN = linked.filter(d => d.day === this.day.date()).length;
    const foot = card.createDiv('pm-pcard-foot');
    const track = foot.createDiv('pm-track');
    const pct = t.done ? 100 : linked.length ? Math.round(doneN / linked.length * 100) : 0;
    track.createDiv('pm-fill').style.width = pct + '%';
    foot.createSpan({ cls: 'pm-meta', text: linked.length ? `${doneN}/${linked.length}` : '未拆分' });
    if (todayN) foot.createSpan({ cls: 'pm-today-tag', text: `今日 ${todayN}` });

    card.addEventListener('pointerdown', e => this.startDrag(e, card, { kind: 'period', task: t }));
    card.addEventListener('dblclick', e => {
      if (e.target.closest('a, .pm-check, .pm-stars')) return;
      this.editPeriod(t);
    });
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem(i => i.setTitle('编辑').setIcon('pencil').onClick(() => this.editPeriod(t)));
      menu.addItem(i => i.setTitle('今天做一部分…').setIcon('calendar-plus').onClick(() => this.splitToDay(t, null)));
      menu.addSeparator();
      for (let lv = 3; lv >= 0; lv--) {
        menu.addItem(i => i
          .setTitle(lv ? `${'★'.repeat(lv)} ${LEVEL_NAMES[lv]}` : '取消星标')
          .setChecked(t.level === lv)
          .onClick(() => upd({ level: lv })));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle('在笔记中定位').setIcon('file-search')
        .onClick(() => this.plugin.openFileAtLine(this.file, t.line)));
      menu.addItem(i => i.setTitle('删除').setIcon('trash').onClick(() => this.remove(scope, t)));
      menu.showAtMouseEvent(e);
    });
    return card;
  }

  editPeriod(t) {
    new TaskModal(this.plugin, {
      title: '编辑周期任务',
      task: t,
      fields: ['level', 'due', 'note'],
      periodEnd: this.period.endDate,
      onSave: patch => this.plugin.updateTask(this.file, { kind: 'period' }, t, patch),
    }).open();
  }

  splitToDay(t, q) {
    q = q || 1;
    new PromptModal(this.plugin, `今天在「${t.text}」上做什么？`, `${t.text}：`, async text => {
      const id = await this.plugin.ensurePeriodId(this.file, t);
      if (!id) return;
      await this.plugin.addDayTask(this.file, this.day.date(), Object.assign({
        text,
        done: false,
        parent: id,
      }, endPos(this.dayTasks, q)));
    }).open();
  }

  // ----- 习惯 -----

  buildHabits(el, today) {
    const row = el.createDiv('pm-habits-row');
    const habits = this.settings.habits;
    const doneToday = habits.filter(h => this.habitsDone.has(h)).length;
    const label = row.createDiv('pm-habits-label');
    label.createSpan({ cls: 'pm-label', text: this.day.isSame(today, 'day') ? '今日习惯' : '当天习惯' });
    label.createSpan({ cls: 'pm-count', text: `${doneToday}/${habits.length}` });

    const p = this.period;
    const elapsed = clamp(today.diff(p.startDate, 'days') + 1, 1, p.endDate.diff(p.startDate, 'days') + 1);
    const list = row.createDiv('pm-habits');
    for (const h of habits) {
      const on = this.habitsDone.has(h);
      const chip = list.createDiv({ cls: 'pm-habit' + (on ? ' is-on' : '') });
      setIcon(chip.createSpan('pm-habit-dot'), 'check');
      chip.createSpan({ cls: 'pm-habit-name', text: h });
      const n = this.habitCounts.get(h) || 0;
      const streak = habitStreak(this.habitByDay, h, this.day.date(), p.start);
      if (streak >= 2) {
        const s = chip.createSpan('pm-habit-streak');
        setIcon(s.createSpan('pm-habit-flame'), 'flame');
        s.createSpan({ text: String(streak) });
      }
      chip.title = (streak ? `连续 ${streak} 天 · ` : '') + `本期打卡 ${n} / ${elapsed} 天`;
      chip.onclick = () => this.plugin.toggleHabit(this.file, this.day.date(), h);
    }
    const edit = list.createDiv({ cls: 'pm-habit is-edit', attr: { 'aria-label': '编辑习惯' } });
    setIcon(edit, habits.length ? 'pencil' : 'plus');
    if (!habits.length) edit.createSpan({ text: '添加习惯' });
    edit.onclick = () => new HabitModal(this.plugin).open();
  }

  // ----- 当天任务 -----

  buildDayHead(el, today) {
    const head = el.createDiv('pm-section-head pm-dayhead');
    const isToday = this.day.isSame(today, 'day');
    head.createEl('h2', { cls: 'pm-h2', text: isToday ? '今日任务' : `${this.day.month() + 1}月${this.day.date()}日的任务` });
    const doneN = this.dayTasks.filter(t => t.done).length;
    if (this.dayTasks.length) head.createSpan({ cls: 'pm-count', text: `${doneN} / ${this.dayTasks.length} 完成` });
    head.createDiv('pm-spacer');
    const lab = head.createEl('label', { cls: 'pm-toggle' });
    lab.createSpan({ text: '隐藏已完成' });
    const cb = lab.createEl('input', { type: 'checkbox' });
    cb.checked = this.settings.hideDone;
    cb.onchange = async () => {
      this.settings.hideDone = cb.checked;
      await this.plugin.saveSettings();
    };
  }

  buildComposer(el) {
    const comp = el.createDiv('pm-composer');
    const input = comp.createEl('input', {
      type: 'text',
      cls: 'pm-composer-input',
      placeholder: `添加任务到「${QUADS[this.lastQuad].title}」，回车确认`,
    });
    input.value = this.draft;
    input.oninput = () => { this.draft = input.value; };

    const tools = comp.createDiv('pm-composer-tools');
    const qbox = tools.createDiv('pm-qpick');
    const qbtns = [];
    const pick = q => {
      this.lastQuad = String(q);
      qbtns.forEach(x => x.toggleClass('is-on', x.dataset.q === this.lastQuad));
      input.placeholder = `添加任务到「${QUADS[q].title}」，回车确认`;
      input.focus();
    };
    for (const q of [1, 2, 4, 3]) {
      const b = qbox.createEl('button', { cls: 'pm-qbtn' + (String(q) === this.lastQuad ? ' is-on' : '') });
      b.dataset.q = String(q);
      b.createSpan('pm-qdot');
      b.createSpan({ text: QUADS[q].name });
      b.onclick = () => pick(q);
      qbtns.push(b);
    }
    this.selectQuad = q => {
      pick(q);
      comp.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    const psel = tools.createEl('select', { cls: 'pm-select is-small' });
    psel.createEl('option', { value: '', text: '不归属周期任务' });
    for (const t of this.periodTasks.filter(p => !p.done)) {
      psel.createEl('option', { value: t.raw, text: `↳ ${t.text}` });
    }
    psel.value = this.periodTasks.some(p => p.raw === this.lastParent) ? this.lastParent : '';
    psel.onchange = () => { this.lastParent = psel.value; };

    tools.createDiv('pm-spacer');
    const send = iconBtn(tools, 'arrow-up', '添加', 'pm-send');

    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      let parent = '';
      const pt = this.periodTasks.find(p => p.raw === psel.value);
      if (pt) {
        parent = await this.plugin.ensurePeriodId(this.file, pt);
        if (!parent) return;
        this.lastParent = formatTask(Object.assign({}, pt, { id: parent }));
      }
      this.draft = '';
      this.focusInput = true;
      await this.plugin.addDayTask(this.file, this.day.date(), Object.assign({
        text,
        done: false,
        parent,
      }, endPos(this.dayTasks, +this.lastQuad)));
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) submit();
    });
    send.onclick = submit;

    if (this.focusInput) {
      this.focusInput = false;
      window.setTimeout(() => input.focus(), 0);
    }
  }

  // ----- 四象限（列表） -----

  visibleIn(q) {
    return quadList(this.dayTasks, q).filter(t => !(this.settings.hideDone && t.done));
  }

  buildBoard(parent) {
    const wrap = parent.createDiv('pm-matrix');
    const yax = wrap.createDiv('pm-yaxis');
    const hi = yax.createDiv('pm-vlabel is-hi');
    for (const c of '重要') hi.createSpan({ text: c });
    yax.createDiv('pm-vline');
    const lo = yax.createDiv('pm-vlabel');
    for (const c of '不重要') lo.createSpan({ text: c });
    const board = wrap.createDiv('pm-board');
    this.board = board;
    this.skyLayers = {};
    this.skyStars = new Map();
    this.sky = null;
    if (this.settings.sky) {
      board.addClass('has-sky');
      this.sky = skyLayout(this.allDaily, this.periodTasks, this.day.date());
    }
    wrap.createDiv();
    const xax = wrap.createDiv('pm-xaxis');
    xax.createSpan({ text: '不紧急' });
    xax.createDiv('pm-hline');
    xax.createSpan({ cls: 'is-hi', text: '紧急' });

    for (const q of [2, 1, 3, 4]) {
      const qd = board.createDiv({ cls: 'pm-quad', attr: { 'data-q': q } });
      if (this.sky) this.buildSky(qd, q);
      const all = quadList(this.dayTasks, q);
      const shown = this.visibleIn(q);
      const n = all.filter(t => !t.done).length;
      const head = qd.createDiv('pm-qhead');
      const out = q === 1 ? this.buildFlame(head, qd) : false;
      if (q !== 1) {
        const icon = head.createSpan('pm-qicon');
        setIcon(icon, QUADS[q].icon);
        if (q === 3 && !n) {
          icon.addClass('pm-steam');
          for (let i = 0; i < 3; i++) icon.createSpan('pm-steam-wisp').style.setProperty('--i', String(i));
        }
      }
      const lab = head.createDiv('pm-qlabel');
      lab.createDiv({ cls: 'pm-qname', text: QUADS[q].title });
      if (out) lab.createDiv({ cls: 'pm-qhint is-out', text: '火已扑灭 · 马上做清空了' });
      else lab.createDiv({ cls: 'pm-qhint', text: QUADS[q].sub });
      const add = iconBtn(head, 'plus', `添加到「${QUADS[q].title}」`, 'pm-qadd');
      add.onclick = () => this.selectQuad && this.selectQuad(q);
      head.createSpan({ cls: 'pm-qcount' + (n ? '' : ' is-zero'), text: String(n) });

      const list = qd.createDiv('pm-qlist');
      for (const t of shown) list.appendChild(this.makeCard(t, true));
      if (!shown.length) {
        const empty = list.createDiv('pm-qempty');
        empty.createSpan({ cls: 'pm-qempty-idle', text: all.length ? '已全部完成' : '暂无任务' });
        empty.createSpan({ cls: 'pm-qempty-drop', text: '松开放到这里' });
      }
    }
  }

  // ----- 星空 -----

  buildSky(qd, q) {
    const sky = qd.createDiv('pm-sky');
    this.skyLayers[q] = sky;
    if (q === 2 || q === 4) sky.createDiv('pm-sky-band');
    if (q === 3) sky.createDiv('pm-sky-moon');
    if (q === 2) sky.createDiv('pm-sky-venus');
    if (q === 1 || q === 2) {
      for (let i = 0; i < 2; i++) sky.createDiv('pm-sky-cloud').style.setProperty('--i', String(i));
    }
    const dust = sky.createDiv('pm-sky-dust');
    for (const d of dustLayout(hashStr(`${this.file.path}|${q}`), 28)) {
      const s = dust.createSpan(d.big ? 'is-big' : '');
      s.style.left = d.x + '%';
      s.style.top = d.y + '%';
      s.style.setProperty('--o', String(d.o));
      s.style.setProperty('--d', d.d + 's');
    }

    const lines = this.sky.lines.filter(l => l.q === q);
    if (lines.length) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'pm-sky-lines');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      for (const l of lines) {
        const pl = document.createElementNS(NS, 'polyline');
        pl.setAttribute('points', l.pts.map(p => p.join(',')).join(' '));
        pl.setAttribute('vector-effect', 'non-scaling-stroke');
        pl.dataset.parent = l.parent;
        svg.appendChild(pl);
      }
      sky.appendChild(svg);
    }

    for (const s of this.sky.stars) {
      if (s.q !== q) continue;
      const el = sky.createDiv({ cls: 'pm-star' + (s.today ? ' is-today' : '') });
      el.dataset.level = String(s.level);
      if (s.parent) el.dataset.parent = s.parent;
      el.style.left = s.x + '%';
      el.style.top = s.y + '%';
      el.style.setProperty('--o', String(s.today ? 1 : Math.max(0.35, 0.85 - s.age * 0.06)));
      el.style.setProperty('--tw', ((hashStr(s.key) % 30) / 10) + 's');
      if (s.level === 3) el.createSpan('pm-star-spark');
      if (s.name) el.createSpan({ cls: 'pm-star-name' + (s.x > 60 ? ' is-right' : ''), text: s.name });
      if (this.pop && this.pop.raw === s.raw && Date.now() <= this.pop.until && this.fxOn()) {
        el.addClass('is-born');
        if (!this.pop.from) el.addClass('is-quick');
        this.popHit = true;
      }
      if (!this.skyStars.has(s.raw)) this.skyStars.set(s.raw, el);
    }
  }

  // 鼠标移到某一行：点亮它的星星和所属主线的星座
  skyHot(t, on) {
    if (!this.sky || t.x == null) return;
    const sky = this.skyLayers[quadOf(t)];
    if (!sky) return;
    const star = t.done ? this.skyStars.get(t.raw) : null;
    if (star) star.toggleClass('is-hot', on);
    sky.toggleClass('is-focus', on && !!(star || t.parent));
    if (!t.parent) return;
    const kin = sky.querySelectorAll(`[data-parent="${t.parent}"]`);
    for (const el of kin) el.toggleClass('is-kin', on);
    const first = [...kin].find(el => el.hasClass('pm-star'));
    if (!star && first) first.toggleClass('is-label', on);
  }

  // 刚完成的任务：一颗流星从勾选圈飞到它的星星
  flyPop() {
    const pop = this.pop;
    if (!pop || !pop.from || pop.flown || !this.fxOn()) return;
    const star = this.skyStars.get(pop.raw);
    if (!star) return;
    pop.flown = true;
    const a = pop.from;
    const b = star.getBoundingClientRect();
    const x0 = a.left + a.width / 2;
    const y0 = a.top + a.height / 2;
    const dx = b.left + b.width / 2 - x0;
    const dy = b.top + b.height / 2 - y0;
    if (Math.hypot(dx, dy) < 8) return;
    const fly = this.fxLayer().createDiv('pm-fly');
    fly.style.left = x0 + 'px';
    fly.style.top = y0 + 'px';
    fly.style.setProperty('--dx', dx.toFixed(1) + 'px');
    fly.style.setProperty('--dy', dy.toFixed(1) + 'px');
    fly.style.color = getComputedStyle(star).color;
    const tail = fly.createDiv('pm-fly-tail');
    tail.style.transform = `rotate(${(Math.atan2(dy, dx) * 180 / Math.PI + 180).toFixed(1)}deg)`;
    fly.addEventListener('animationend', () => fly.remove());
  }

  meteor() {
    if (!this.settings.sky || !this.fxOn() || document.hidden) return;
    if (!this.contentEl.hasClass('pm-dark') || !this.board || !this.board.isConnected) return;
    if (Math.random() < 0.45) return;
    const skies = Object.values(this.skyLayers || {}).filter(s => s.isConnected);
    if (!skies.length) return;
    const sky = skies[Math.floor(Math.random() * skies.length)];
    const m = sky.createDiv('pm-meteor');
    m.style.left = (45 + Math.random() * 50) + '%';
    m.style.top = (Math.random() * 45) + '%';
    m.addEventListener('animationend', () => m.remove());
  }

  buildTimeline(parent, today) {
    const tl = parent.createDiv('pm-timeline');
    const head = tl.createDiv('pm-section-head');
    head.createEl('h3', { cls: 'pm-h3', text: '日程' });
    const n = this.dayTasks.filter(t => t.slot).length;
    head.createSpan({ cls: 'pm-count', text: n ? `${n} 项` : '点击时段添加' });
    const isToday = this.day.isSame(today, 'day');
    const hour = moment().hour();
    const list = tl.createDiv('pm-slots');
    for (const slot of this.settings.slots) {
      const s = list.createDiv({ cls: 'pm-slot', attr: { 'data-slot': slot } });
      if (isToday && slotHasHour(slot, hour)) s.addClass('is-now');
      s.createDiv({ cls: 'pm-slot-time', text: slot.replace('-', '–') });
      const box = s.createDiv('pm-slot-items');
      const items = this.dayTasks.filter(d => d.slot === slot);
      for (const t of items) {
        const chip = box.createDiv({ cls: 'pm-chip' + (t.done ? ' is-done' : '') });
        chip.dataset.q = t.x != null ? String(quadOf(t)) : '';
        chip.createSpan({ cls: 'pm-chip-text', text: t.text });
        const x = chip.createSpan({ cls: 'pm-chip-x', text: '×' });
        x.title = '移出日程';
        x.onclick = e => {
          e.stopPropagation();
          this.plugin.updateTask(this.file, this.dayScope(), t, { slot: '' });
        };
        chip.onclick = e => e.stopPropagation();
        chip.ondblclick = () => this.editDay(t);
      }
      const plus = box.createDiv('pm-slot-add');
      setIcon(plus.createSpan(), 'plus');
      if (!items.length) plus.createSpan({ text: '安排' });
      s.onclick = () => this.openSlot(slot);
    }
  }

  openSlot(slot) {
    new SlotModal(this.plugin, {
      slot,
      quad: +this.lastQuad,
      candidates: this.dayTasks.filter(t => !t.done && !t.slot),
      onPick: t => this.plugin.updateTask(this.file, this.dayScope(), t, { slot }),
      onNew: (text, q) => this.plugin.addDayTask(this.file, this.day.date(), Object.assign({
        text,
        done: false,
        slot,
      }, endPos(this.dayTasks, q))),
    }).open();
  }

  buildTray(el) {
    const list = this.dayTasks.filter(t => t.x == null && !(this.settings.hideDone && t.done));
    if (!list.length) return;
    const tray = el.createDiv('pm-tray');
    const head = tray.createDiv('pm-section-head');
    head.createEl('h3', { cls: 'pm-h3', text: '待放置' });
    head.createSpan({ cls: 'pm-count', text: `${list.length} 项 · 在笔记里直接写的任务，拖进上面的象限` });
    const box = tray.createDiv('pm-tray-list');
    for (const t of list) box.appendChild(this.makeCard(t, false));
  }

  buildTips(el) {
    const tip = el.createDiv('pm-tips');
    setIcon(tip.createSpan('pm-tips-icon'), 'lightbulb');
    tip.createSpan({
      text: '拖周期任务卡片进象限可以拆出今天的子任务；拖任务上下调整顺序，拖到右侧时段排进日程；双击编辑，右键更多操作，⌘Z 撤销。',
    });
    iconBtn(tip, 'x', '不再显示').onclick = async () => {
      this.settings.hideTips = true;
      await this.plugin.saveSettings();
    };
  }

  makeCard(t, inQuad) {
    const card = createDiv({ cls: 'pm-card' + (inQuad ? ' is-row' : '') });
    const scope = this.dayScope();
    const upd = patch => this.plugin.updateTask(this.file, scope, t, patch);
    if (t.done) card.addClass('is-done');
    if (t.x != null) card.dataset.q = String(quadOf(t));

    const chk = buildCheck(card, t.done, (v, el) => this.setDone(scope, t, v, el));
    if (this.popMatch(t)) this.replayPop(chk, card);
    if (inQuad && this.sky) {
      card.addEventListener('pointerenter', () => this.skyHot(t, true));
      card.addEventListener('pointerleave', () => this.skyHot(t, false));
    }

    const body = card.createDiv('pm-card-body');
    const txt = body.createDiv('pm-text');
    renderMd(this.app, t.text, txt, this.file.path, this.renderComp);
    this.bindLinks(txt);

    const tags = [];
    const parent = t.parent ? this.periodTasks.find(p => p.id === t.parent) : null;
    if (parent) tags.push({ cls: 'pm-parent', text: parent.text });
    if (t.slot) tags.push({ cls: 'pm-slot-tag', text: t.slot.replace('-', '–') });
    if (t.due) {
      const d = countdown(t.due);
      tags.push({ cls: `pm-due ${d.cls}`, text: d.text });
    }
    if (this.carried.has(t.raw)) tags.push({ cls: 'pm-carry-tag', text: '顺延' });
    if (t.note) tags.push({ cls: 'pm-note-tag', text: '备注', title: t.note });
    if (tags.length) {
      const row = body.createDiv('pm-tags');
      for (const tg of tags) {
        const s = row.createSpan({ cls: tg.cls, text: tg.text });
        if (tg.title) s.title = tg.title;
      }
    }

    card.addEventListener('pointerdown', e => this.startDrag(e, card, { kind: 'day', task: t }));
    card.addEventListener('dblclick', e => {
      if (e.target.closest('a, .pm-check')) return;
      this.editDay(t);
    });
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem(i => i.setTitle('编辑').setIcon('pencil').onClick(() => this.editDay(t)));
      menu.addItem(i => i.setTitle('在笔记中定位').setIcon('file-search')
        .onClick(() => this.plugin.openFileAtLine(this.file, t.line)));
      menu.addSeparator();
      for (const q of [1, 2, 4, 3]) {
        if (t.x != null && quadOf(t) === q) continue;
        menu.addItem(i => i.setTitle(`移到「${QUADS[q].title}」`).setIcon(QUADS[q].icon)
          .onClick(() => this.plugin.updateTask(this.file, scope, t, endPos(this.dayTasks, q))));
      }
      if (t.x != null) {
        menu.addItem(i => i.setTitle('移回待放置').setIcon('inbox').onClick(() => upd({ x: null, y: null })));
      }
      if (t.slot) {
        menu.addItem(i => i.setTitle('移出日程').setIcon('clock').onClick(() => upd({ slot: '' })));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle('删除').setIcon('trash').onClick(() => this.remove(scope, t)));
      menu.showAtMouseEvent(e);
    });
    return card;
  }

  editDay(t) {
    new TaskModal(this.plugin, {
      title: '编辑任务',
      task: t,
      fields: ['note', 'parent', 'slot', 'due'],
      parents: this.periodTasks,
      slots: this.settings.slots,
      periodEnd: this.period.endDate,
      onSave: async patch => {
        if (patch.parentRaw !== undefined) {
          const pt = this.periodTasks.find(p => p.raw === patch.parentRaw);
          patch.parent = pt ? await this.plugin.ensurePeriodId(this.file, pt) || '' : '';
          delete patch.parentRaw;
        }
        await this.plugin.updateTask(this.file, this.dayScope(), t, patch);
      },
    }).open();
  }

  bindLinks(el) {
    el.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      if (this.justDragged) return;
      if (a.hasClass('internal-link')) {
        this.app.workspace.openLinkText(a.getAttr('data-href') || a.getAttr('href'), this.file.path, 'split');
      } else if (a.href) {
        window.open(a.href);
      }
    });
  }

  // ----- 拖拽：浮起一个副本，原卡片留在原地变淡 -----

  startDrag(e, card, src) {
    if (e.button !== 0 || e.target.closest('input, a, button, select, textarea, .pm-check, .pm-stars')) return;
    const doc = card.ownerDocument;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    let ghost = null;
    let host = null;
    let line = null;
    let overSlot = null;
    let overQuad = null;
    let dropIndex = 0;

    const targetAt = ev => {
      const hit = doc.elementFromPoint(ev.clientX, ev.clientY);
      return {
        slot: hit && src.kind === 'day' ? hit.closest('.pm-slot') : null,
        quad: hit ? hit.closest('.pm-quad') : null,
      };
    };

    const indexIn = (quad, y) => {
      const rows = [...quad.querySelectorAll('.pm-qlist > .pm-card')].filter(r => r !== card);
      let i = 0;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (y > b.top + b.height / 2) i++;
      }
      return { i, rows };
    };

    const cleanup = () => {
      if (host) host.remove();
      if (line) line.remove();
      if (overSlot) overSlot.removeClass('is-over');
      if (overQuad) overQuad.removeClass('is-over');
      card.removeClass('is-dragsrc');
      if (this.board) this.board.removeClass('is-dragging');
      this.contentEl.removeClass('is-dragging');
    };

    const onMove = ev => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return;
        moved = true;
        this.dragging = true;
        const r = card.getBoundingClientRect();
        host = doc.body.createDiv('pm-ghost-host');
        applySkin(host, this.plugin);
        ghost = card.cloneNode(true);
        ghost.addClass('pm-ghost');
        ghost.style.width = r.width + 'px';
        ghost.style.left = r.left + 'px';
        ghost.style.top = r.top + 'px';
        host.appendChild(ghost);
        card.addClass('is-dragsrc');
        this.board.addClass('is-dragging');
        this.contentEl.addClass('is-dragging');
        line = createDiv('pm-dropline');
      }
      ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(1.5deg)`;

      const tgt = targetAt(ev);
      if (tgt.slot !== overSlot) {
        if (overSlot) overSlot.removeClass('is-over');
        if (tgt.slot) tgt.slot.addClass('is-over');
        overSlot = tgt.slot;
      }
      if (tgt.quad !== overQuad) {
        if (overQuad) overQuad.removeClass('is-over');
        if (tgt.quad) tgt.quad.addClass('is-over');
        overQuad = tgt.quad;
      }
      if (src.kind === 'day' && overQuad) {
        const { i, rows } = indexIn(overQuad, ev.clientY);
        dropIndex = i;
        const list = overQuad.querySelector('.pm-qlist');
        if (i < rows.length) list.insertBefore(line, rows[i]);
        else list.appendChild(line);
        ghost.dataset.q = overQuad.dataset.q;
      } else {
        line.remove();
      }
    };

    const onUp = async () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onUp);
      if (!moved) return;
      this.justDragged = true;
      window.setTimeout(() => { this.justDragged = false; }, 50);
      const slot = overSlot;
      const quad = overQuad;
      cleanup();
      this.dragging = false;

      if (src.kind === 'period') {
        if (quad) this.splitToDay(src.task, +quad.dataset.q);
        return;
      }
      if (slot) {
        await this.plugin.updateTask(this.file, this.dayScope(), src.task, { slot: slot.dataset.slot });
        return;
      }
      if (quad) {
        const q = +quad.dataset.q;
        const patches = reorderPatches(this.visibleIn(q), src.task, q, dropIndex);
        await this.plugin.updateMany(this.file, this.dayScope(), patches);
      }
    };

    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);
  }
}

// ---------- 弹窗 ----------

class SkinModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  skin(title, sub) {
    applySkin(this.modalEl, this.plugin);
    this.modalEl.addClass('pm-modal');
    this.contentEl.empty();
    this.contentEl.createEl('h3', { cls: 'pm-modal-title', text: title });
    if (sub) this.contentEl.createDiv({ cls: 'pm-modal-sub', text: sub });
  }

  field(label) {
    const f = this.contentEl.createDiv('pm-field');
    f.createDiv({ cls: 'pm-field-label', text: label });
    return f.createDiv('pm-field-body');
  }

  footer(okText, onOk) {
    const f = this.contentEl.createDiv('pm-modal-foot');
    textBtn(f, '取消', 'is-ghost').onclick = () => this.close();
    textBtn(f, okText, 'is-primary').onclick = onOk;
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TaskModal extends SkinModal {
  constructor(plugin, opts) {
    super(plugin);
    this.opts = opts;
    const t = opts.task;
    this.values = {
      text: t.text || '',
      level: t.level || 0,
      due: t.due || '',
      slot: t.slot || '',
      note: t.note || '',
    };
    this.origNote = t.note || '';
    if (opts.fields.includes('parent')) {
      const p = (opts.parents || []).find(x => x.id && x.id === t.parent);
      this.values.parentRaw = p ? p.raw : '';
    }
  }

  onOpen() {
    const { fields } = this.opts;
    this.skin(this.opts.title);
    this.modalEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.save();
      }
    });

    const ti = this.field('内容').createEl('input', { type: 'text', cls: 'pm-input is-lg' });
    ti.value = this.values.text;
    ti.placeholder = '要做什么';
    ti.oninput = () => { this.values.text = ti.value; };
    ti.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && !e.metaKey && !e.ctrlKey) this.save();
    });
    window.setTimeout(() => ti.focus(), 0);

    if (fields.includes('level')) {
      const body = this.field('重要程度');
      const draw = () => {
        body.empty();
        buildStars(body, this.values.level, v => {
          this.values.level = v;
          draw();
        }, 'is-lg');
        body.createSpan({ cls: 'pm-star-label', text: LEVEL_NAMES[this.values.level] });
      };
      draw();
    }

    if (fields.includes('due')) {
      buildDatePicker(this.field('截止日期'), {
        value: this.values.due,
        periodEnd: this.opts.periodEnd,
        onChange: v => { this.values.due = v; },
      });
    }

    if (fields.includes('note')) {
      const ta = this.field('备注').createEl('textarea', { cls: 'pm-input pm-textarea' });
      ta.value = this.values.note;
      ta.rows = 4;
      ta.placeholder = '想法、链接、子步骤都可以写。会存在任务下方的缩进行里，支持 Markdown。';
      ta.oninput = () => { this.values.note = ta.value; };
    }

    if (fields.includes('parent')) {
      const sel = this.field('归属周期任务').createEl('select', { cls: 'pm-select' });
      sel.createEl('option', { value: '', text: '不归属' });
      for (const p of this.opts.parents) sel.createEl('option', { value: p.raw, text: p.text });
      sel.value = this.values.parentRaw;
      sel.onchange = () => { this.values.parentRaw = sel.value; };
    }

    if (fields.includes('slot')) {
      const body = this.field('日程时段');
      const box = body.createDiv('pm-dp-chips');
      const draw = () => {
        box.empty();
        for (const s of ['', ...this.opts.slots]) {
          const b = box.createEl('button', { cls: 'pm-chipbtn' + (s === this.values.slot ? ' is-on' : ''), text: s || '未安排' });
          b.onclick = () => {
            this.values.slot = s;
            draw();
          };
        }
      };
      draw();
    }

    this.footer('保存', () => this.save());
  }

  save() {
    const text = this.values.text.trim();
    if (!text) {
      new Notice('内容不能为空');
      return;
    }
    const patch = { text };
    const { fields } = this.opts;
    if (fields.includes('level')) patch.level = this.values.level;
    if (fields.includes('due')) patch.due = this.values.due;
    if (fields.includes('slot')) patch.slot = this.values.slot;
    if (fields.includes('parent')) patch.parentRaw = this.values.parentRaw;
    if (fields.includes('note') && this.values.note !== this.origNote) patch.note = this.values.note;
    this.opts.onSave(patch);
    this.close();
  }
}

class PromptModal extends SkinModal {
  constructor(plugin, title, value, onSubmit) {
    super(plugin);
    this.title = title;
    this.value = value;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.skin(this.title, '会加到当天的小节里，并挂在这个周期任务下面。');
    const input = this.field('任务').createEl('input', { type: 'text', cls: 'pm-input is-lg' });
    input.value = this.value;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) this.submit(input.value);
    });
    window.setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    this.footer('添加', () => this.submit(input.value));
  }

  submit(v) {
    const text = v.trim();
    if (!text) return;
    this.close();
    this.onSubmit(text);
  }
}

class SlotModal extends SkinModal {
  constructor(plugin, opts) {
    super(plugin);
    this.opts = opts;
    this.quad = opts.quad || 1;
  }

  onOpen() {
    const { slot, candidates } = this.opts;
    this.skin(`${slot.replace('-', '–')} 安排什么？`, '新写一个任务，或者从今天还没排进日程的任务里选。');
    const input = this.field('新任务').createEl('input', { type: 'text', cls: 'pm-input is-lg' });
    input.placeholder = '输入后回车';
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) this.submit(input.value);
    });
    window.setTimeout(() => input.focus(), 0);

    const qb = this.field('放进象限').createDiv('pm-qpick');
    const draw = () => {
      qb.empty();
      for (const q of [1, 2, 4, 3]) {
        const b = qb.createEl('button', { cls: 'pm-qbtn' + (q === this.quad ? ' is-on' : '') });
        b.dataset.q = String(q);
        b.createSpan('pm-qdot');
        b.createSpan({ text: QUADS[q].title });
        b.onclick = () => {
          this.quad = q;
          draw();
        };
      }
    };
    draw();

    if (candidates.length) {
      const list = this.field('或选择已有任务').createDiv('pm-pick-list');
      for (const t of candidates) {
        const row = list.createDiv('pm-pick-row');
        row.createSpan({ cls: 'pm-qdot', attr: { 'data-q': t.x != null ? String(quadOf(t)) : '' } });
        row.createSpan({ cls: 'pm-pick-text', text: t.text });
        setIcon(row.createSpan('pm-pick-go'), 'chevron-right');
        row.onclick = () => {
          this.close();
          this.opts.onPick(t);
        };
      }
    }
    this.footer('添加', () => this.submit(input.value));
  }

  submit(v) {
    const text = v.trim();
    if (!text) return;
    this.close();
    this.opts.onNew(text, this.quad);
  }
}

class HabitModal extends SkinModal {
  constructor(plugin) {
    super(plugin);
    this.list = [...plugin.settings.habits];
  }

  onOpen() {
    this.draw();
  }

  draw(focus) {
    this.skin('每日习惯', '每天都想坚持的事，比如健身、阅读、冥想。可以加 emoji，顺序就是显示顺序。');
    const box = this.contentEl.createDiv('pm-hlist');
    this.list.forEach((h, i) => {
      const row = box.createDiv('pm-hrow');
      row.createSpan({ cls: 'pm-hrow-idx', text: String(i + 1) });
      const inp = row.createEl('input', { type: 'text', cls: 'pm-input' });
      inp.value = h;
      inp.placeholder = '例如：🏃 健身 30 分钟';
      inp.oninput = () => { this.list[i] = inp.value; };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) {
          this.list.splice(i + 1, 0, '');
          this.draw(i + 1);
        }
      });
      if (focus === i) window.setTimeout(() => inp.focus(), 0);
      const up = iconBtn(row, 'arrow-up', '上移');
      up.disabled = i === 0;
      up.onclick = () => {
        [this.list[i - 1], this.list[i]] = [this.list[i], this.list[i - 1]];
        this.draw();
      };
      const down = iconBtn(row, 'arrow-down', '下移');
      down.disabled = i === this.list.length - 1;
      down.onclick = () => {
        [this.list[i + 1], this.list[i]] = [this.list[i], this.list[i + 1]];
        this.draw();
      };
      iconBtn(row, 'x', '删除', 'is-danger').onclick = () => {
        this.list.splice(i, 1);
        this.draw();
      };
    });
    textBtn(this.contentEl, '添加习惯', 'is-ghost pm-hadd', 'plus').onclick = () => {
      this.list.push('');
      this.draw(this.list.length - 1);
    };
    this.contentEl.createDiv({ cls: 'pm-modal-note', text: '改名或删除只影响之后的打卡，以前写在笔记里的记录不会变。' });
    this.footer('保存', () => this.save());
  }

  async save() {
    const clean = [...new Set(this.list.map(s => s.replace(/[✅⬜]/g, '').trim()).filter(Boolean))];
    this.plugin.settings.habits = clean;
    await this.plugin.saveSettings();
    this.close();
  }
}

class NewPeriodModal extends SkinModal {
  constructor(plugin, start, end) {
    super(plugin);
    this.start = start.format('YYYY-MM-DD');
    this.end = end.format('YYYY-MM-DD');
    this.migrate = true;
  }

  onOpen() {
    this.skin('新建时段笔记', '一期通常是 10 天左右，开始和结束要在同一个月。');
    const preview = createDiv('pm-preview');
    const updatePreview = () => {
      const s = moment(this.start, 'YYYY-MM-DD', true);
      const e = moment(this.end, 'YYYY-MM-DD', true);
      preview.setText(s.isValid() && e.isValid()
        ? `将创建 ${s.year()}/${pad(s.month() + 1)}/${s.date()}-${e.date()}.md，共 ${e.diff(s, 'days') + 1} 天`
        : '请选择日期');
    };
    const endQuick = () => {
      const s = moment(this.start, 'YYYY-MM-DD');
      return [10, 20, s.daysInMonth()]
        .filter(d => d >= s.date())
        .map(d => [d === s.daysInMonth() ? '月末' : `${d} 日`, s.clone().date(d)]);
    };

    buildDatePicker(this.field('开始日期'), {
      value: this.start,
      quick: [['今天', moment().startOf('day')]],
      clearable: false,
      noCountdown: true,
      onChange: v => {
        if (!v) return;
        this.start = v;
        this.end = defaultEnd(moment(v, 'YYYY-MM-DD')).format('YYYY-MM-DD');
        drawEnd();
        updatePreview();
      },
    });
    const endBody = this.field('结束日期');
    const drawEnd = () => {
      endBody.empty();
      buildDatePicker(endBody, {
        value: this.end,
        quick: endQuick(),
        clearable: false,
        noCountdown: true,
        onChange: v => {
          if (!v) return;
          this.end = v;
          updatePreview();
        },
      });
    };
    drawEnd();

    const mig = this.field('迁移');
    const lab = mig.createEl('label', { cls: 'pm-toggle' });
    const cb = lab.createEl('input', { type: 'checkbox' });
    cb.checked = this.migrate;
    cb.onchange = () => { this.migrate = cb.checked; };
    lab.createSpan({ text: '把上一期没完成的周期任务移过来' });
    mig.createDiv({ cls: 'pm-modal-note', text: '没做完的每日任务不用迁移，会在当天自动顺延。' });

    this.contentEl.appendChild(preview);
    updatePreview();
    this.footer('创建', () => this.create());
  }

  async create() {
    const s = moment(this.start, 'YYYY-MM-DD', true);
    const e = moment(this.end, 'YYYY-MM-DD', true);
    if (!s.isValid() || !e.isValid()) {
      new Notice('日期格式不对');
      return;
    }
    const file = await this.plugin.createPeriod(s, e, this.migrate);
    if (!file) return;
    this.close();
    this.plugin.refreshViews();
    await this.plugin.openFileAtLine(file, 0);
  }
}

class MatrixSettingTab extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    new Setting(containerEl)
      .setName('配色')
      .setDesc('浅色或深色，也可以跟随 Obsidian 的明暗模式')
      .addDropdown(dd => dd
        .addOption('auto', '跟随 Obsidian')
        .addOption('light', '浅色')
        .addOption('dark', '深色')
        .setValue(s.theme)
        .onChange(async v => {
          s.theme = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('界面字号')
      .addDropdown(dd => dd
        .addOption('s', '小 14px')
        .addOption('m', '中 16px')
        .addOption('l', '大 18px')
        .addOption('xl', '特大 20px')
        .setValue(s.size)
        .onChange(async v => {
          s.size = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('趣味动画')
      .setDesc('完成时的弹跳、粒子和彩带，「马上做」的火苗。系统开启「减弱动态效果」时会自动关闭。')
      .addToggle(tg => tg.setValue(!!s.fx).onChange(async v => {
        s.fx = v;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('星空背景')
      .setDesc('四个象限的背景变成天空：每完成一个任务，就在它所在的象限点亮一颗星。同一主线下的星星连成星座。深色是夜空，浅色是黄昏。')
      .addToggle(tg => tg.setValue(!!s.sky).onChange(async v => {
        s.sky = v;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('每日习惯')
      .setDesc(s.habits.join('、') || '还没有设置')
      .addButton(b => b.setButtonText('编辑').onClick(() => {
        const m = new HabitModal(this.plugin);
        const close = m.onClose.bind(m);
        m.onClose = () => {
          close();
          this.display();
        };
        m.open();
      }));
    new Setting(containerEl)
      .setName('日程时段')
      .setDesc('格式如 07-09，用英文逗号分隔')
      .addText(tc => tc.setValue(s.slots.join(',')).onChange(async v => {
        s.slots = v.split(',').map(x => x.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      }));
  }
}

module.exports = WorkmapPlugin;
module.exports._test = {
  periodRange,
  listDays,
  dayRange,
  parseTaskLine,
  collectTasks,
  formatTask,
  taskBlock,
  ensureDay,
  insertTaskBlock,
  parseHabits,
  formatHabits,
  quadOf,
  quadList,
  spreadY,
  endPos,
  reorderPatches,
  habitStreak,
  heatOf,
  longestStreak,
  periodStats,
  hashStr,
  rng,
  skyLayout,
  dustLayout,
  parsePeriod,
  defaultEnd,
  splitLines,
  countChildren,
  readNote,
  noteLines,
};
