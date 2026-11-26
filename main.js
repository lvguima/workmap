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
  requestUrl,
} = require('obsidian');

// ---------- 常量 ----------

const VIEW_TYPE = 'workmap-view';
const TEMPLATE_PATH = 'tools/period-template.md';
const PERIOD_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{1,2})\.md$/;
const PERIOD_HEAD_RE = /^##\s+(周期任务|四象限)\s*$/;
const DAY_HEAD_RE = /^##\s+(\d{1,2})\s*$/;
const H12_RE = /^#{1,2}\s/;
const HR_RE = /^---\s*$/;
// [ ] 未开始、[/] 进行中、[x] 完成、[-] 已取消。[>] 是已顺延，不算任务
const TASK_RE = /^- \[([ xX/-])\] ?(.*)$/;
const EMPTY_TASK_RE = /^- \[ \]\s*$/;
const META_RE = /\s*%%(m|p|t|id|c):([^%\n]*)%%/g;
const NOTES_HEAD_RE = /^##\s+本期笔记\s*$/;
const NOTE_LINK_RE = /^- \[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/;
const DUE_RE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const STAR_RE = /\s*(★{1,3})(?=\s|$)/;
const HABIT_RE = /^习惯[：:]\s*(.*)$/;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const LEVEL_NAMES = ['不标星', '一般', '重要', '最重要'];
const SIZES = { s: 14, m: 16, l: 18, xl: 20 };

const DEFAULT_SETTINGS = {
  hideDone: false,
  slots: ['07-09', '09-11', '11-12', '14-16', '16-18', '20-22', '22-24'],
  theme: 'auto',
  size: 'm',
  hideTips: false,
  carry: null,
  fx: true,
  sky: true,
  carryHold: '',
  carryMode: 'mark',        // 顺延后原来那行：mark 改成 [>]，move 直接删掉
  carryStart: '',           // 顺延起点 YYYY-MM-DD：早于这天的任务不顺延。空 = 只看上一期
  aiKey: '',
  aiBase: 'https://www.dmxapi.cn/v1',
  aiModel: 'claude-sonnet-5-5',
  agentModel: 'claude-sonnet-5-5',
  agentEffort: 'medium',
  agentCtx: { today: true, yesterday: true, period: true, notes: false },
  brief: null,              // 今日简报缓存：{ date, at, model, text, usage }
  migrations: [],           // 提前建好的下一期：等它开始那天再迁移周期任务 [{ from, to }]
};

// DMXAPI 上常用的对话模型，设置里也可以填别的
const AI_MODELS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5（推荐）'],
  ['claude-opus-5-5', 'Claude Opus 5.5（更强，更贵）'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5（快、便宜）'],
  ['gpt-5.5', 'GPT-5.5'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['qwen3.8-max', 'Qwen 3.8 Max'],
];

// 时区：key 存在设置里。美国有多个时区，具体用哪个由 usZone 决定
const ZONES = [
  { key: 'us', label: '美国' },
  { key: 'hk', label: '香港', tz: 'Asia/Hong_Kong' },
  { key: 'paris', label: '巴黎', tz: 'Europe/Paris' },
];
const US_ZONES = [
  ['America/New_York', '东部', '东部（纽约）'],
  ['America/Chicago', '中部', '中部（芝加哥）'],
  ['America/Denver', '山地', '山地（丹佛）'],
  ['America/Los_Angeles', '西部', '西部（洛杉矶）'],
];

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
    regexp: /\s?%%(?:m|p|t|id|c):[^%\n]*%%/g,
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

// ---------- 时区 ----------
// 笔记里的日期都是「墙上时间」，所以这里把所选时区的当前时间换成一个同样读数的本地 moment，
// 其余的日期比较、加减都不用改。没有选时区（activeTz 为空）时就是系统时间。

let activeTz = '';
const zoneFormats = new Map();

function zoneParts(date, tz) {
  if (!zoneFormats.has(tz)) {
    zoneFormats.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }));
  }
  const out = {};
  for (const { type, value } of zoneFormats.get(tz).formatToParts(date)) {
    if (type !== 'literal') out[type] = +value;
  }
  return out;
}

function momentIn(date, tz) {
  const p = zoneParts(date, tz);
  return moment({ year: p.year, month: p.month - 1, date: p.day, hour: p.hour, minute: p.minute, second: p.second });
}

function zoneNow() {
  return activeTz ? momentIn(new Date(), activeTz) : moment();
}

// 小时单独取：本地时区夏令时跳过的那一小时，换算成本地 moment 后读数会偏
function zoneHour() {
  return activeTz ? zoneParts(new Date(), activeTz).hour : moment().hour();
}

function zoneTz(key, usZone) {
  if (key === 'us') return usZone;
  const z = ZONES.find(x => x.key === key);
  return (z && z.tz) || '';
}

function guessZone(sys) {
  if (US_ZONES.some(z => z[0] === sys)) return 'us';
  return (ZONES.find(z => z.tz === sys) || { key: '' }).key;
}

function utcOffsetLabel(date, tz) {
  const p = zoneParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const mins = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const abs = Math.abs(mins);
  return `UTC${mins < 0 ? '-' : '+'}${Math.floor(abs / 60)}${abs % 60 ? ':' + pad(abs % 60) : ''}`;
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
  const mark = m[1].toLowerCase();
  return {
    line: i,
    raw: line,
    done: mark === 'x' || mark === '-',
    cancelled: mark === '-',
    doing: mark === '/',
    text: body,
    level,
    due,
    x,
    y,
    id: meta.id || '',
    parent: meta.p || '',
    slot: meta.t || '',
    since: /^\d{4}-\d{2}-\d{2}$/.test(meta.c || '') ? meta.c : '',
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

function taskMark(t) {
  if (t.done) return t.cancelled ? '-' : 'x';
  return t.doing ? '/' : ' ';
}

function formatTask(t) {
  let s = `- [${taskMark(t)}] ${t.text}`;
  if (t.level) s += ' ' + '★'.repeat(clamp(t.level, 1, 3));
  if (t.due) s += ` 📅 ${t.due}`;
  if (t.id) s += ` %%id:${t.id}%%`;
  if (t.parent) s += ` %%p:${t.parent}%%`;
  if (t.slot) s += ` %%t:${t.slot}%%`;
  if (t.since) s += ` %%c:${t.since}%%`;
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

// 一期里没完成的周期任务块（任务行和备注）
function openPeriodBlocks(lines) {
  const r = periodRange(lines);
  if (!r) return [];
  return collectTasks(lines, r, 'period')
    .filter(t => !t.done)
    .map(t => ({ raw: t.raw, id: t.id, text: t.text, block: [formatTask(t), ...lines.slice(t.line + 1, t.line + 1 + t.children)] }));
}

// 把周期任务块加到某一期的周期任务区末尾。编号或文字已经在的跳过，返回加了几个
function insertPeriodBlocks(lines, blocks) {
  let r = periodRange(lines);
  if (!r) {
    lines.unshift('## 周期任务', '');
    r = periodRange(lines);
  }
  const have = collectTasks(lines, r, 'period');
  const add = blocks.filter(b => !have.some(t => (b.id && t.id === b.id) || t.text === b.text));
  if (!add.length) return 0;
  let at = r.start;
  for (let i = r.start + 1; i < r.end; i++) if (lines[i].trim()) at = i;
  const ins = add.flatMap(b => b.block);
  lines.splice(at + 1, 0, ...(at === r.start ? ['', ...ins] : ins));
  return add.length;
}

// 从 source 里删掉这些块（按原文找）
function removePeriodBlocks(lines, blocks) {
  for (const b of blocks) {
    const r = periodRange(lines);
    const idx = r ? findRaw(lines, r, b.raw) : -1;
    if (idx >= 0) lines.splice(idx, 1 + countChildren(lines, idx, r.end));
  }
}

// 拖动排序：把 srcRaw 那一块（任务行和备注）挪到 beforeRaw 那一块前面；beforeRaw 为空就挪到最后一个任务后面。
// 找不到行返回 false（笔记在渲染之后被改过）
function moveTaskBlock(lines, range, srcRaw, beforeRaw) {
  const si = findRaw(lines, range, srcRaw);
  if (si < 0 || srcRaw === beforeRaw) return false;
  const n = 1 + countChildren(lines, si, range.end);
  const block = lines.splice(si, n);
  const r = { start: range.start, end: range.end - n };
  let at = -1;
  if (beforeRaw) {
    at = findRaw(lines, r, beforeRaw);
    if (at < 0) return false;
  } else {
    for (let i = r.start + 1; i < r.end; i++) {
      if (TASK_RE.test(lines[i])) at = i + 1 + countChildren(lines, i, r.end);
    }
    if (at < 0) at = r.start + 1;
  }
  lines.splice(at, 0, ...block);
  return true;
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

const CARRIED_RE = /^- \[>\] ?(.*)$/;

function dayDate(p, day) {
  if (day < 1 || day > p.startDate.daysInMonth()) return null;
  return p.startDate.clone().date(day);
}

// 老的顺延任务没有 %%c%%：从 day 往前逐个小节找同名的 [>]，连续找到的最早那天就是最初安排的日子。
// 中间断开就停，免得把很久以前同名的另一件事算进来。找不到返回 ''
function chainOrigin(lines, p, text, day) {
  const days = listDays(lines).filter(d => d.day < day).sort((a, b) => b.day - a.day);
  let origin = '';
  for (const d of days) {
    let hit = null;
    for (let i = d.start + 1; i < d.end && !hit; i++) {
      const m = CARRIED_RE.exec(lines[i]);
      if (!m) continue;
      const t = parseTaskLine('- [ ] ' + m[1], i);
      if (t && t.text === text) hit = t;
    }
    if (!hit) break;
    if (hit.since) return hit.since;
    const date = dayDate(p, d.day);
    if (!date) break;
    origin = date.format('YYYY-MM-DD');
  }
  return origin;
}

// 自动顺延：找出某一期里早于 today 的未完成每日任务（任务行连同备注）。
// line 是任务行在 lines 里的位置，markCarried 要在同一份 lines 上用它。
// 顺延出去的块带上 %%c:最初安排的日期%%，这样能算出一件事拖了几天。
// from：顺延起点（moment），早于它的日子不管
function collectCarry(lines, p, today, from) {
  const out = [];
  for (const d of listDays(lines)) {
    const date = dayDate(p, d.day);
    if (!date || !date.isBefore(today, 'day')) continue;
    if (from && date.isBefore(from, 'day')) continue;
    for (let i = d.start + 1; i < d.end; i++) {
      const t = parseTaskLine(lines[i], i);
      if (!t || t.done || !t.text) continue;
      const kids = countChildren(lines, i, d.end);
      const since = t.since || chainOrigin(lines, p, t.text, d.day) || date.format('YYYY-MM-DD');
      const block = [formatTask(Object.assign({}, t, { slot: '', since })), ...lines.slice(i + 1, i + 1 + kids)];
      out.push({
        line: i,
        kids,
        day: d.day,
        raw: lines[i],
        orig: lines.slice(i, i + 1 + kids),
        block,
        info: { raw: block[0], text: t.text, from: `${p.month}/${d.day}`, since },
      });
    }
  }
  return out;
}

// mode = 'mark'：原行改成 [>]，留下每天的记录；'move'：原行连同备注直接删掉
function markCarried(lines, items, mode) {
  if (mode === 'move') {
    for (const it of [...items].sort((a, b) => b.line - a.line)) lines.splice(it.line, 1 + it.kids);
    return;
  }
  for (const it of items) {
    lines[it.line] = lines[it.line].replace(/^- \[[ /]\]/, '- [>]');
    it.marked = lines[it.line];
  }
}

// 顺延失败时把上一期改过的地方还原
function unmarkCarried(lines, items, mode) {
  if (mode === 'move') {
    for (const it of items) insertTaskBlock(lines, ensureDay(lines, it.day), it.orig);
    return;
  }
  for (const it of items) {
    const idx = lines.indexOf(it.marked);
    if (idx >= 0) lines[idx] = it.raw;
  }
}

// 拖了几天：从最初安排的那天到 day
function carryAge(since, day) {
  const d = parseDate(since);
  return d ? day.clone().startOf('day').diff(d, 'days') : 0;
}

// ---------- 本期笔记 ----------
// 学习笔记、会议记录这类长内容单独存成文件，放在「年/月/起-止/」文件夹里；
// 时段笔记里只留一个「## 本期笔记」小节，每行一个链接。这样笔记里的标题和 --- 不会打乱时段笔记的结构。

function notesRange(lines) {
  const start = lines.findIndex(l => NOTES_HEAD_RE.test(l));
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

function listNoteLinks(lines) {
  const r = notesRange(lines);
  if (!r) return [];
  const out = [];
  for (let i = r.start + 1; i < r.end; i++) {
    const m = NOTE_LINK_RE.exec(lines[i]);
    if (m) out.push({ line: i, raw: lines[i], link: m[1].trim(), title: (m[2] || '').trim() });
  }
  return out;
}

// 没有这一节时，加在周期任务后面（分隔线 --- 之前）
function ensureNotesSection(lines) {
  const exist = notesRange(lines);
  if (exist) return exist;
  const pr = periodRange(lines);
  if (!pr) {
    lines.unshift('## 本期笔记', '');
    return notesRange(lines);
  }
  let at = pr.end;
  while (at > pr.start + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, '', '## 本期笔记');
  return notesRange(lines);
}

function noteLinkLine(path, title) {
  return `- [[${path.replace(/\.md$/, '')}|${title.replace(/[|\]]/g, ' ').trim()}]]`;
}

function addNoteLink(lines, linkLine) {
  const r = ensureNotesSection(lines);
  let at = r.start;
  for (let i = r.start + 1; i < r.end; i++) {
    if (lines[i].trim()) at = i;
  }
  lines.splice(at + 1, 0, ...(at === r.start ? ['', linkLine] : [linkLine]));
}

// 不属于任何小节的正文：在周期任务、本期笔记、各天小节以外，又不是空行或 --- 的内容
// （周期任务前面的前言不算）。通常是直接粘贴进来的学习笔记。
// 返回 [{ start, end }]，end 不含，首尾的空行和 --- 已去掉，中间的 --- 保留
function strayBlocks(lines) {
  const pr = periodRange(lines);
  if (!pr) return [];
  const covered = new Uint8Array(lines.length);
  const cover = r => {
    if (r) for (let i = r.start; i < r.end; i++) covered[i] = 1;
  };
  cover({ start: 0, end: pr.end });
  cover(notesRange(lines));
  for (const d of listDays(lines)) cover(d);
  const blank = l => !l.trim() || HR_RE.test(l);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (covered[i] || blank(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    let last = i;
    while (j < lines.length && !covered[j]) {
      if (!blank(lines[j])) last = j;
      j++;
    }
    blocks.push({ start: i, end: last + 1 });
    i = j;
  }
  return blocks;
}

function safeFileName(s) {
  const name = (s || '')
    .replace(/[*_`~]/g, '')
    .replace(/[\\/:?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return name || '未命名笔记';
}

// 一段内容的标题：第一个 Markdown 标题，没有就取第一行的前 30 个字
function strayTitle(blockLines) {
  for (const l of blockLines) {
    const m = /^#{1,6}\s+(.+)$/.exec(l);
    if (m) return safeFileName(m[1]);
  }
  const first = blockLines.find(l => l.trim()) || '';
  return safeFileName(first.replace(/^[-*>\s]+/, '').slice(0, 30));
}

// 把所有游离内容从时段笔记里拿出来。返回 [{ title, text }]；lines 原地修改
function takeStray(lines) {
  const blocks = strayBlocks(lines);
  const out = blocks.map(b => {
    const ls = lines.slice(b.start, b.end);
    return { title: strayTitle(ls), text: ls.join('\n') + '\n' };
  });
  for (const b of [...blocks].reverse()) {
    lines.splice(b.start, b.end - b.start);
    // 拿掉后两边留下的连续空行合并成一个
    let a = b.start;
    while (a > 0 && !lines[a - 1].trim()) a--;
    let z = b.start;
    while (z < lines.length && !lines[z].trim()) z++;
    if (z - a > 1) lines.splice(a + 1, z - a - 1);
  }
  return out;
}

// ---------- 大模型回顾 ----------

function statusText(t) {
  if (t.cancelled) return '已取消';
  if (t.done) return '已完成';
  if (t.doing) return '进行中';
  return '未完成';
}

// 把一期笔记整理成给大模型看的纯文本：去掉 %%…%% 元数据，写清楚状态、象限、拖了几天
function periodTaskLines(pts, daily) {
  const out = [];
  for (const t of pts) {
    const linked = t.id ? daily.filter(d => d.parent === t.id && !d.cancelled) : [];
    let line = `- [${statusText(t)}] ${t.text}`;
    if (t.level) line += ` · 重要程度：${LEVEL_NAMES[t.level]}`;
    if (t.due) line += ` · 截止 ${t.due}`;
    line += ` · 拆出的每日任务完成 ${linked.filter(x => x.done).length}/${linked.length}`;
    out.push(line);
    if (t.note) out.push(...t.note.split('\n').map(l => '  ' + l));
  }
  return out;
}

// 某一天小节里的任务，一行一个：状态、主线、象限、时段、拖了几天，下面是备注
function dayDigest(lines, p, d, parentName) {
  const date = dayDate(p, d.day);
  if (!date) return [];
  const out = [];
  for (const t of collectTasks(lines, d, 'day')) {
    let line = `- [${statusText(t)}] ${t.text}`;
    const pn = parentName(t.parent);
    if (pn) line += ` ← 主线「${pn}」`;
    if (t.x != null) line += ` · ${QUADS[quadOf(t)].name}`;
    if (t.slot) line += ` · 时段 ${t.slot}`;
    const since = t.since || chainOrigin(lines, p, t.text, d.day);
    const age = since ? carryAge(since, date) : 0;
    if (age > 0) line += t.done ? ` · 拖了 ${age} 天才完成` : ` · 最早安排在 ${since}，已拖 ${age} 天`;
    out.push(line);
    if (t.note) out.push(...t.note.split('\n').map(l => '  ' + l));
  }
  let moved = 0;
  for (let i = d.start + 1; i < d.end; i++) if (CARRIED_RE.test(lines[i])) moved++;
  if (moved) out.push(`- （另有 ${moved} 项当天没做完，顺延到了后面）`);
  return out;
}

function parentNamer(pts) {
  return id => {
    const t = id && pts.find(x => x.id === id);
    return t ? t.text : '';
  };
}

function periodDigest(o) {
  const { p, lines, today, notes } = o;
  const out = [];
  const total = p.endDate.date() - p.start + 1;
  const nth = clamp(today.diff(p.startDate, 'days') + 1, 1, total);
  out.push(`# 时段：${p.year} 年 ${p.month} 月 ${p.start}–${p.endDate.date()} 日（共 ${total} 天）`);
  out.push(`今天是 ${today.format('YYYY-MM-DD')}，本期第 ${nth} 天。`);

  const pr = periodRange(lines);
  const pts = pr ? collectTasks(lines, pr, 'period') : [];
  const days = listDays(lines).filter(d => dayDate(p, d.day)).sort((a, b) => a.day - b.day);
  const daily = days.flatMap(d => collectTasks(lines, d, 'day').map(t => Object.assign(t, { day: d.day })));
  const parentName = parentNamer(pts);

  out.push('', '## 周期任务（这一期的主线）');
  if (!pts.length) out.push('（没有）');
  out.push(...periodTaskLines(pts, daily));

  out.push('', '## 每天的任务');
  for (const d of days) {
    const ls = dayDigest(lines, p, d, parentName);
    if (!ls.length) continue;
    const date = dayDate(p, d.day);
    out.push('', `### ${date.format('M/D')} 周${WEEK[date.day()]}`, ...ls);
  }

  if (notes && notes.length) {
    out.push('', '## 本期笔记');
    for (const n of notes) out.push('', `### 《${n.title}》`, '', n.text.trim());
  }
  return out.join('\n');
}

function httpErrorText(status, msg) {
  const hint = {
    401: '密钥无效',
    403: '密钥被禁用或额度用完了',
    404: '接口地址不对',
    413: '内容太长',
    429: '请求太频繁',
    503: '这个模型现在不可用，检查模型名',
  }[status];
  return `HTTP ${status}${hint ? ` · ${hint}` : ''}${msg ? `：${msg}` : ''}`;
}

const AI_REVIEW_PROMPT = `你是我的个人复盘助手。下面是我这一期（大约 10 天）的时段笔记：周期任务是主线，每天的任务按艾森豪威尔四象限分类，「已拖 N 天」表示这件事被一天天顺延了多久，最后是这期记下的学习笔记。

请用中文写一份复盘，直接输出 Markdown，不要开场白和客套话。结构：

## 一句话总结
## 主线进展
逐条说每个周期任务推进到哪了、还差什么。没有拆出每日任务的主线要点出来。
## 时间花在哪了
各象限的分布、哪些天做得多、哪些天几乎空白，以及从中看出的节奏问题。
## 拖延与卡点
列出拖得最久的任务，分析可能的原因（任务太大、不清楚下一步、优先级不对……），每条给一个具体的拆法或下一步。
## 这期学到了什么
从本期笔记里提炼 3–6 个要点；没有笔记就跳过这一节。
## 下一期建议
3–5 条，具体到可以直接写成任务。

要求：基于笔记里的事实说话，引用具体任务名；不要编造笔记里没有的内容；不夸奖、不鸡汤，像一位直率的同事。`;

const AI_QUIZ_PROMPT = `你是我的学习教练。下面是我最近记的学习笔记。请根据内容出一套复习题，帮我检查是否真正理解，直接输出 Markdown，不要开场白。

要求：
- 出 8–12 道题，覆盖笔记里最重要的概念；由易到难：先是概念辨析，再是原理理解，最后 2–3 道结合实际场景的应用题。
- 题型混合：简答、判断并说明理由、情景分析。不要出纯记忆的填空题。
- 每道题的格式：

### 第 N 题（概念 / 理解 / 应用）
题目内容

> [!note]- 参考答案
> 答案要点，以及对应笔记里的哪部分

- 最后加一节「## 容易混淆的地方」，列出 2–4 个笔记里容易弄错的点。
- 只依据笔记内容出题和作答；笔记里没讲清楚的地方，在答案里注明「笔记未覆盖」。`;

// ---------- 工作助理 ----------

const AGENT_VIEW = 'workmap-agent';
// api：anthropic 走 DMXAPI 的 /v1/messages（推理强度要这样传才生效），其他走 OpenAI 兼容的 /v1/chat/completions
const AGENT_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', api: 'anthropic' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', api: 'openai' },
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', api: 'openai' },
];
const EFFORTS = [['low', '低'], ['medium', '中'], ['high', '高']];
const CHAT_DIR = '对话';
const AGENT_CTX = [['today', '今天'], ['yesterday', '昨天'], ['period', '本期主线'], ['notes', '本期笔记']];

function agentModel(id) {
  return AGENT_MODELS.find(m => m.id === id) || { id, label: id, api: /^claude/.test(id) ? 'anthropic' : 'openai' };
}

function buildChatRequest(o) {
  const { base, key, model, effort, system, messages, stream } = o;
  const m = agentModel(model);
  const b = (base || 'https://www.dmxapi.cn/v1').replace(/\/+$/, '');
  if (m.api === 'anthropic') {
    return {
      url: `${b}/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: { model: m.id, max_tokens: 16000, stream: !!stream, system, messages, thinking: { type: 'adaptive' }, output_config: { effort } },
    };
  }
  const body = {
    model: m.id,
    max_tokens: 16000,
    stream: !!stream,
    reasoning_effort: effort,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (stream) body.stream_options = { include_usage: true };
  return { url: `${b}/chat/completions`, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body };
}

// 流式输出：把收到的文本切成 SSE 的 data 事件。最后一行可能不完整，放回 rest 等下一块
function sseSplit(buf) {
  const parts = buf.split(/\r?\n/);
  const rest = parts.pop();
  const events = [];
  for (const line of parts) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      events.push(JSON.parse(d));
    } catch (e) {
      // 不是 JSON 的行（心跳之类）跳过
    }
  }
  return { rest, events };
}

// 两种接口的流式事件统一成 { text, thinking, usage, error }
function streamDelta(api, ev) {
  const out = { text: '', thinking: '', usage: null, error: '' };
  if (ev.error) {
    out.error = (ev.error && ev.error.message) || JSON.stringify(ev.error);
    return out;
  }
  if (api === 'anthropic') {
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta') out.text = ev.delta.text || '';
      if (ev.delta.type === 'thinking_delta') out.thinking = ev.delta.thinking || '';
    } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      out.usage = { input: ev.message.usage.input_tokens };
    } else if (ev.type === 'message_delta' && ev.usage) {
      out.usage = { input: ev.usage.input_tokens, output: ev.usage.output_tokens, cost: ev.usage.cost || '' };
    }
    return out;
  }
  const c = ev.choices && ev.choices[0];
  if (c && c.delta) {
    out.text = c.delta.content || '';
    out.thinking = c.delta.reasoning_content || '';
  }
  if (ev.usage) out.usage = { input: ev.usage.prompt_tokens, output: ev.usage.completion_tokens };
  return out;
}

// 不流式时的回复
function replyOf(api, data) {
  if (api === 'anthropic') {
    const blocks = data.content || [];
    return {
      text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
      thinking: blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join(''),
      usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens, cost: data.usage.cost || '' } : null,
    };
  }
  const m = (data.choices && data.choices[0] && data.choices[0].message) || {};
  return {
    text: m.content || '',
    thinking: m.reasoning_content || '',
    usage: data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } : null,
  };
}

// 助理建议的改动写在回复末尾的 ```workmap 代码块里（JSON 数组），由用户确认后执行
const ACTION_RE = /```workmap[^\S\n]*\n([\s\S]*?)```/;
const ACTION_OPS = ['add', 'done', 'doing', 'cancel', 'move', 'slot', 'addPeriod'];

function parseActions(text) {
  const m = ACTION_RE.exec(text || '');
  if (!m) return { text: text || '', actions: [] };
  let list = [];
  try {
    const v = JSON.parse(m[1]);
    list = (Array.isArray(v) ? v : [v]).filter(a => a && ACTION_OPS.includes(a.op));
  } catch (e) {
    return { text, actions: [] };
  }
  return { text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), actions: list.slice(0, 12) };
}

// 流式输出时先不显示还没写完的操作块
function visibleReply(text) {
  const i = (text || '').indexOf('```workmap');
  return i < 0 ? text || '' : text.slice(0, i).trimEnd();
}

function describeAction(a) {
  const q = QUADS[a.quad] ? `「${QUADS[a.quad].title}」` : '';
  switch (a.op) {
    case 'add': return `新增今天的任务${q ? '到' + q : ''}：${a.text}${a.parent ? `（主线：${a.parent}）` : ''}`;
    case 'done': return `标为完成：${a.task}`;
    case 'doing': return `标为进行中：${a.task}`;
    case 'cancel': return `标为已取消：${a.task}`;
    case 'move': return `移到${q || '别的象限'}：${a.task}`;
    case 'slot': return `排进 ${a.slot}：${a.task}`;
    case 'addPeriod': return `新增本期主线：${a.text}${a.level ? ' ' + '★'.repeat(clamp(+a.level, 1, 3)) : ''}${a.due ? ` 📅 ${a.due}` : ''}`;
    default: return a.op;
  }
}

// 按名字找任务：先找完全一样的，再找唯一包含它的
function matchTask(tasks, name) {
  const n = (name || '').trim();
  if (!n) return null;
  const exact = tasks.filter(t => t.text === n);
  if (exact.length) return exact.find(t => !t.done) || exact[0];
  const part = tasks.filter(t => t.text.includes(n) || n.includes(t.text));
  return part.length === 1 ? part[0] : null;
}

// 对话存成 md：每条消息一个「### 🧑 我」或「### 🤖 助理」小标题，操作块原样留在助理消息后面
function formatChat(chat) {
  const out = ['---', 'workmap: chat', `created: ${chat.created}`, '---', '', `# ${chat.title}`, ''];
  for (const m of chat.messages) {
    out.push(m.role === 'user' ? `### 🧑 我 · ${m.time}` : `### 🤖 助理 · ${m.model} · ${m.time}`, '');
    let body = (m.content || '').trim();
    if (m.actions && m.actions.length) body += '\n\n```workmap\n' + JSON.stringify(m.actions) + '\n```';
    out.push(body, '');
  }
  return out.join('\n');
}

function parseChat(text) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const created = fm && (/^created:\s*(.+)$/m.exec(fm[1]) || [])[1];
  const body = fm ? text.slice(fm[0].length) : text;
  const title = (/^# (.+)$/m.exec(body) || [])[1] || '对话';
  const messages = [];
  const re = /^### (🧑 我|🤖 助理) · (.+)$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(body))) heads.push({ at: m.index, end: m.index + m[0].length, who: m[1], meta: m[2] });
  heads.forEach((h, i) => {
    const raw = body.slice(h.end, i + 1 < heads.length ? heads[i + 1].at : body.length).trim();
    if (h.who === '🧑 我') {
      messages.push({ role: 'user', content: raw, time: h.meta.trim() });
    } else {
      const parts = h.meta.split(' · ');
      const time = parts.pop().trim();
      const { text: content, actions } = parseActions(raw);
      messages.push({ role: 'assistant', content, actions, model: parts.join(' · ').trim(), time });
    }
  });
  return { title: title.trim(), created: (created || '').trim(), messages };
}

function chatTitle(text) {
  return safeFileName((text || '').trim().replace(/\s+/g, ' ').slice(0, 24)) || '对话';
}

// 给助理的上下文：现在的时间、本期主线、今天和昨天的任务、本期笔记，按开关取舍
function agentContext(o) {
  const { now, cur, prev, flags, notes } = o;
  const out = [`现在：${now.format('YYYY-MM-DD')} 周${WEEK[now.day()]} ${now.format('HH:mm')}`];
  if (!cur) {
    out.push('今天还没有对应的时段笔记。');
    return out.join('\n');
  }
  const { p, lines } = cur;
  const total = p.endDate.date() - p.start + 1;
  out.push(`本期：${p.year} 年 ${p.month} 月 ${p.start}–${p.endDate.date()} 日，第 ${clamp(now.diff(p.startDate, 'days') + 1, 1, total)} 天，共 ${total} 天`);
  const pr = periodRange(lines);
  const pts = pr ? collectTasks(lines, pr, 'period') : [];
  const days = listDays(lines);
  const daily = days.flatMap(d => collectTasks(lines, d, 'day'));
  const name = parentNamer(pts);
  if (flags.period) {
    out.push('', '## 本期主线');
    out.push(...(pts.length ? periodTaskLines(pts, daily) : ['（没有）']));
  }
  const section = (src, date, label) => {
    const d = src && date ? listDays(src.lines).find(x => x.day === date.date()) : null;
    out.push('', `## ${label}（${date.format('M/D')} 周${WEEK[date.day()]}）`);
    const ls = d ? dayDigest(src.lines, src.p, d, name) : [];
    out.push(...(ls.length ? ls : ['（没有任务）']));
  };
  if (flags.today) section(cur, now, '今天的任务');
  if (flags.yesterday) section(prev, now.clone().subtract(1, 'day'), '昨天的任务');
  if (flags.notes && notes && notes.length) {
    out.push('', '## 本期笔记');
    for (const n of notes) out.push('', `### 《${n.title}》`, '', n.text.trim());
  }
  return out.join('\n');
}

function agentSystem(slots, context) {
  return `你是我的私人工作管理助理，嵌在我的 Obsidian 插件 Workmap 里。Workmap 用「时段笔记」管理工作：一期约 10 天，有几条主线（周期任务），每天的任务按艾森豪威尔四象限分类：1 马上做（重要且紧急）、2 排时间做（重要不紧急）、3 少做或不做、4 尽快处理（紧急不重要）。「已拖 N 天」表示这件事被一天天顺延了多久。

下面「上下文」是插件刚从笔记里读出来的最新内容，以它为准。

回答要求：中文；先给结论，再给理由；具体到任务名和第一步怎么做；不编造上下文里没有的信息，不确定就直说或者问我；默认简短，我要详细时再展开。

你不能直接改笔记。需要建议具体改动时（比如我请你安排、拆分、调整今天的任务，或者你看到明显该做的调整），在回复最后附一个语言标记为 workmap 的代码块，内容是 JSON 数组，我在界面上确认后插件才会执行：

\`\`\`workmap
[{"op":"add","text":"读 reviewer#2 第 1–3 条意见并分类","quad":1,"parent":"TIM_response"}]
\`\`\`

支持的操作：
- add：新增今天的任务。text 必填；quad 1–4；parent 可选，填本期主线的原文；note 可选。
- done / doing / cancel：把今天的某个任务标成完成 / 进行中 / 已取消，task 填任务原文。
- move：task + quad，换象限。
- slot：task + slot，排进日程，slot 只能是 ${slots.join('、')} 之一。
- addPeriod：新增本期主线，text 必填，level 0–3（重要程度），due 可选（YYYY-MM-DD）。
只在确实需要时附加，一次最多 8 条，只改今天的任务；正文里不要再重复这段 JSON，用一句话说明你建议了哪些改动即可。

# 上下文

${context}`;
}

const AGENT_BRIEF_PROMPT = `给我一份今日简报，直接输出 Markdown，不要开场白，整体 350 字以内：

### 今天
按建议的顺序列出今天要做的事（最多 6 条），拖了 3 天以上的标出来。
### 昨天
完成了什么、没完成什么，一两句话。
### 主线
只写有进展或有风险的主线，一行一条。
### 笔记要点
最近笔记里值得记住的 2–3 点；没有笔记就省略这一节。
### 先做这件
今天最该先做的一件事，以及具体的第一步。

这次不要附加 workmap 操作块。`;

const AGENT_QUICK = [
  ['今天先做什么', '今天我应该先做什么？按顺序排一下，说明理由。'],
  ['总结昨天', '总结一下我昨天做了什么、没做完什么，以及今天该怎么接上。'],
  ['拖延分析', '这一期哪些事拖得最久？分别卡在哪，怎么破？必要时帮我拆成今天能做的小任务。'],
  ['拆解任务', '帮我把「」拆成今天能完成的几个小任务，放进合适的象限。'],
  ['考考我', '根据本期笔记出 3 道题考我，先只给题目，等我回答后再讲解。'],
];

// 中文输入法选字时按的回车不算提交。Safari / iPad 上这时 isComposing 可能已经是 false，但 keyCode 仍是 229
function isSubmitKey(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
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
    .filter(t => t.done && !t.cancelled && t.x != null && t.day != null && t.day <= viewDay)
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
      o: Math.round((0.2 + rand() * 0.45) * 100) / 100,
      d: Math.round(rand() * 60) / 10,
      dur: Math.round((2 + rand() * 3.5) * 10) / 10,
      big: rand() < 0.22,
      tw: rand() < 0.55,
      glint: rand() < 0.06,
    });
  }
  return out;
}

// 银河：从「少做或不做」左下缓缓升起，弧过「尽快处理」，从「马上做」右上角出去。
// 坐标是整张看板的比例（0–1），避开四个象限交汇的中心。
const GALAXY = [[-0.06, 0.97], [0.42, 0.6], [0.78, 0.66], [1.06, 0.1]];

function galaxyAt(t) {
  const [p0, p1, p2, p3] = GALAXY;
  const u = 1 - t;
  const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  const d = [-3 * u * u, 3 * u * u - 6 * u * t, 6 * u * t - 3 * t * t, 3 * t * t];
  const pick = (w, i) => w[0] * p0[i] + w[1] * p1[i] + w[2] * p2[i] + w[3] * p3[i];
  return { x: pick(b, 0), y: pick(b, 1), dx: pick(d, 0), dy: pick(d, 1) };
}

// 光带宽度沿途起伏，中段鼓起一点（像银心）
function galaxyWidth(t) {
  const bulge = Math.exp(-(((t - 0.5) / 0.17) ** 2));
  return 0.72 + 0.16 * Math.sin(t * 7.3 + 1.1) + 0.1 * Math.sin(t * 17.9 + 0.4) + 0.5 * bulge;
}

// 银河的组成：大片薄雾、河心的光团、暗尘带、密集的小星、星团和少数会闪的亮星。
// 位置用 (t, off) 表示：t 是沿河的位置，off 是偏离河心的距离（以当地河宽为单位）。
function galaxyLayout(seed) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const r3 = v => Math.round(v * 1000) / 1000;
  const T = () => r3(rand());
  const haze = [];
  const glow = [];
  const lanes = [];
  const stars = [];
  const bright = [];
  for (let i = 0; i < 70; i++) {
    haze.push({ t: T(), off: r3(gauss() * 0.7), r: r3(2.2 + rand() * 1.8), a: r3(0.022 + rand() * 0.028), hue: r3(rand()) });
  }
  for (let i = 0; i < 220; i++) {
    const t = rand();
    const fade = 0.35 + 0.65 * Math.sin(Math.PI * t) ** 0.6;
    glow.push({ t: r3(t), off: r3(gauss() * 0.3), r: r3(0.45 + rand() * 1.1), a: r3((0.04 + rand() * 0.07) * fade), hue: r3(rand()) });
  }
  for (let k = 0; k < 3; k++) {
    const t0 = 0.08 + k * 0.3 + rand() * 0.08;
    const len = 0.12 + rand() * 0.14;
    const base = (k % 2 ? -1 : 1) * (0.1 + rand() * 0.25);
    for (let i = 0; i < 36; i++) {
      const u = i / 35;
      const env = Math.sin(Math.PI * u);
      lanes.push({
        t: r3(t0 + u * len),
        off: r3(base + 0.22 * Math.sin(u * 5.5 + k * 2) + gauss() * 0.06),
        r: r3(0.12 + env * (0.18 + rand() * 0.22)),
        a: r3(0.08 + env * 0.38),
      });
    }
  }
  const tone = () => {
    const k = rand();
    return k < 0.62 ? 0 : k < 0.8 ? 1 : k < 0.92 ? 2 : 3;
  };
  for (let i = 0; i < 1900; i++) {
    const wide = rand() < 0.25;
    const off = gauss() * (wide ? 1.4 : 0.6);
    const core = Math.exp(-off * off / 1.2);
    stars.push({
      t: T(),
      off: r3(off),
      r: r3(0.35 + Math.pow(rand(), 4) * 1.1),
      a: r3(Math.min(1, 0.12 + core * 0.55 + rand() * 0.3)),
      tone: tone(),
    });
  }
  for (let k = 0; k < 4; k++) {
    const t0 = 0.15 + k * 0.22 + rand() * 0.06;
    const o0 = gauss() * 0.4;
    for (let i = 0; i < 70; i++) {
      stars.push({
        t: r3(t0 + gauss() * 0.018),
        off: r3(o0 + gauss() * 0.22),
        r: r3(0.4 + Math.pow(rand(), 3) * 0.9),
        a: r3(0.45 + rand() * 0.5),
        tone: rand() < 0.5 ? 0 : 2,
      });
    }
  }
  for (let i = 0; i < 16; i++) {
    bright.push({
      t: r3(0.04 + rand() * 0.92),
      off: r3(gauss() * 0.8),
      r: r3(1.6 + rand() * 1.1),
      tone: rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 3),
      tw: Math.round(rand() * 50) / 10,
      dur: Math.round((2.2 + rand() * 2.6) * 10) / 10,
    });
  }
  return { haze, glow, lanes, stars, bright };
}

const GALAXY_TONES = ['248,248,255', '190,210,255', '255,228,180', '255,190,225'];

// 把整条银河画到一张看板大小的离屏画布上；返回画布和亮星的位置（百分比）
function renderGalaxy(g, W, H, dpr, dark) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(W * dpr));
  cv.height = Math.max(1, Math.round(H * dpr));
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const base = 0.05 * Math.min(H, W * 0.6);
  const at = (t, off) => {
    const p = galaxyAt(t);
    const tx = p.dx * W;
    const ty = p.dy * H;
    const len = Math.hypot(tx, ty) || 1;
    const s = base * galaxyWidth(t);
    return { x: p.x * W - (ty / len) * off * s, y: p.y * H + (tx / len) * off * s, s };
  };
  const blob = (x, y, r, rgb, a) => {
    if (r <= 0 || a <= 0) return;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${a})`);
    gr.addColorStop(0.4, `rgba(${rgb},${a * 0.5})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const pal = dark
    ? { core: '255,236,214', warm: '255,214,232', mid: '186,198,255', edge: '146,128,255', k: 1 }
    : { core: '255,255,255', warm: '255,214,200', mid: '255,236,228', edge: '232,210,255', k: 4 };

  ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
  for (const b of g.haze) {
    const p = at(b.t, b.off);
    blob(p.x, p.y, p.s * b.r, b.hue < 0.5 ? pal.edge : pal.mid, b.a * pal.k);
  }
  for (const b of g.glow) {
    const p = at(b.t, b.off);
    blob(p.x, p.y, p.s * b.r, b.hue < 0.65 ? pal.core : pal.warm, b.a * pal.k * (dark ? 1 : 0.8));
  }
  ctx.globalCompositeOperation = 'destination-out';
  for (const l of g.lanes) {
    const p = at(l.t, l.off);
    blob(p.x, p.y, p.s * l.r, '0,0,0', l.a * (dark ? 1 : 0.5));
  }
  ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
  for (const s of g.stars) {
    const p = at(s.t, s.off);
    ctx.fillStyle = `rgba(${dark ? GALAXY_TONES[s.tone] : '255,255,255'},${dark ? s.a : Math.min(1, s.a * 1.15)})`;
    if (s.r < 0.75) {
      ctx.fillRect(p.x, p.y, s.r * 1.3, s.r * 1.3);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const bright = g.bright.map(b => {
    const p = at(b.t, b.off);
    return { x: (p.x / W) * 100, y: (p.y / H) * 100 };
  });
  return { canvas: cv, bright };
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

// 一段日子里最长连续几天
function longestRun(days, from, to) {
  let best = 0;
  let run = 0;
  for (let d = from; d <= to; d++) {
    run = days.has(d) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function periodStats(o) {
  const { periodTasks, allDaily, start, end, day } = o;
  const to = Math.min(day, end);
  const daily = allDaily.filter(t => !t.cancelled);
  const doneDays = new Set(daily.filter(t => t.done && t.day >= start && t.day <= to).map(t => t.day));
  return {
    periodDone: periodTasks.filter(t => t.done && !t.cancelled).length,
    periodTotal: periodTasks.length,
    dailyDone: daily.filter(t => t.done).length,
    dailyTotal: daily.length,
    activeDays: doneDays.size,
    bestRun: longestRun(doneDays, start, to),
    nth: clamp(day - start + 1, 1, end - start + 1),
    total: end - start + 1,
  };
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

function inPeriod(p, d) {
  return !d.isBefore(p.startDate, 'day') && !d.isAfter(p.endDate, 'day');
}

// 新建一期的日期有什么问题；没问题返回空字符串
function periodProblem(start, end, periods) {
  if (!start.isValid() || !end.isValid()) return '日期格式不对';
  if (end.isBefore(start, 'day')) return '结束日期不能早于开始日期';
  if (start.year() !== end.year() || start.month() !== end.month()) return '开始和结束日期需要在同一个月';
  const clash = periods.find(p => !(end.isBefore(p.startDate, 'day') || start.isAfter(p.endDate, 'day')));
  if (clash) return `和已有的 ${clash.file.path} 日期重叠`;
  return '';
}

// 新建一期的默认日期：从今天（或今天所在那一期的下一天）开始，跳过已经建好的期，结束日不和后面的期重叠
function suggestPeriod(today, periods) {
  let start = today.clone().startOf('day');
  for (let p = periods.find(x => inPeriod(x, start)); p; p = periods.find(x => inPeriod(x, start))) {
    start = p.endDate.clone().add(1, 'day');
  }
  return { start, end: periodEndFor(start, periods) };
}

// 给定开始日的默认结束日：10 日、20 日或月末，碰到后面已有的一期就停在它前一天
function periodEndFor(start, periods) {
  const end = defaultEnd(start);
  const next = periods
    .filter(x => x.startDate.isAfter(start, 'day') && !x.startDate.isAfter(end, 'day'))
    .sort((a, b) => a.startDate.valueOf() - b.startDate.valueOf())[0];
  return next ? next.startDate.clone().subtract(1, 'day') : end;
}

// 用模板生成新一期的内容。模板里没有 {{tasks}} 时，迁移的任务放到「## 周期任务」下面
// （没有这一节就加在最前面），不能因为模板没写占位符就把它们弄丢
function fillTemplate(tpl, blocks, day) {
  const content = tpl.split('{{day}}').join(day);
  if (content.includes('{{tasks}}')) return content.split('{{tasks}}').join(blocks.map(b => b.join('\n')).join('\n'));
  if (!blocks.length) return content;
  const { lines, eol } = splitLines(content);
  const r = periodRange(lines);
  const ins = blocks.flat();
  if (r) lines.splice(r.start + 1, 0, '', ...ins);
  else lines.unshift('## 周期任务', '', ...ins, '');
  return lines.join(eol);
}

function parseDate(v) {
  const d = moment(v, 'YYYY-MM-DD', true);
  return d.isValid() ? d : null;
}

function daysUntil(due) {
  const d = parseDate(due);
  return d ? d.diff(zoneNow().startOf('day'), 'days') : NaN;
}

function countdown(due) {
  const n = daysUntil(due);
  if (Number.isNaN(n)) return { text: `${due} · 日期无效`, short: '日期无效', cls: 'is-over' };
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
  el.classList.toggle('pm-space', !!plugin.settings.sky);
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
  const today = zoneNow().startOf('day');
  const wrap = parent.createDiv('pm-dp');
  let value = opts.value || '';
  let open = false;
  // 手写的日期可能不合法（比如 2026-02-30），这时日历从今天所在的月开始
  const monthOf = v => (parseDate(v) || today.clone()).startOf('month');
  let view = monthOf(value);

  let quick = opts.quick;
  if (!quick) {
    const fri = today.clone().isoWeekday(5);
    // 今天是周五时，「今天」已经有了，这一项就是下周五
    const friLabel = today.isoWeekday() === 5 ? '下周五' : '周五';
    if (!fri.isAfter(today, 'day')) fri.add(1, 'week');
    quick = [
      ['今天', today.clone()],
      ['明天', today.clone().add(1, 'day')],
      [friLabel, fri],
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
    if (v) view = monthOf(v);
    opts.onChange(v);
    draw();
  };

  function draw() {
    field.empty();
    setIcon(field.createSpan('pm-dp-icon'), 'calendar');
    const d = value ? parseDate(value) : null;
    if (d) {
      field.createSpan({ cls: 'pm-dp-value', text: `${d.year()}年${d.month() + 1}月${d.date()}日 周${WEEK[d.day()]}` });
      if (!opts.noCountdown) {
        const c = countdown(value);
        field.createSpan({ cls: `pm-pill ${c.cls}`, text: c.short });
      }
    } else if (value) {
      field.createSpan({ cls: 'pm-dp-value', text: value });
      field.createSpan({ cls: 'pm-pill is-over', text: '日期无效，请重新选择' });
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
    if (open) view = monthOf(value);
    draw();
  };
  // 点日历以外的地方就收起日历。选择器被移除后，下一次点击时顺手卸掉监听
  const doc = wrap.ownerDocument;
  const onDocDown = e => {
    if (!wrap.isConnected) {
      doc.removeEventListener('pointerdown', onDocDown, true);
      return;
    }
    if (open && !wrap.contains(e.target)) {
      open = false;
      draw();
    }
  };
  doc.addEventListener('pointerdown', onDocDown, true);
  draw();
  return {
    setValue(v) {
      value = v;
      if (v) view = monthOf(v);
      draw();
    },
  };
}

// ---------- 插件 ----------

class WorkmapPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    delete this.settings.habits; // 0.6.0 去掉了每日习惯
    this.carrying = false;
    this.aiBusy = false;
    this.history = [];
    this.autoWrites = new Map(); // 文件路径 → 最近一次自动写入（顺延、跳到今天）的时间
    const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (this.settings.zone === undefined) this.settings.zone = guessZone(sys);
    if (!US_ZONES.some(z => z[0] === this.settings.usZone)) {
      this.settings.usZone = US_ZONES.some(z => z[0] === sys) ? sys : 'America/New_York';
    }
    activeTz = zoneTz(this.settings.zone, this.settings.usZone);

    this.settings.agentCtx = Object.assign({}, DEFAULT_SETTINGS.agentCtx, this.settings.agentCtx);
    this.registerView(VIEW_TYPE, leaf => new MatrixView(leaf, this));
    this.registerView(AGENT_VIEW, leaf => new AgentView(leaf, this));
    this.addRibbonIcon('layout-grid', '打开 Workmap', () => this.activateView());
    this.addRibbonIcon('bot', '工作助理（再点一次收起）', () => this.toggleAgent());
    this.addCommand({ id: 'open-agent', name: '打开 / 收起工作助理', callback: () => this.toggleAgent() });
    this.addCommand({ id: 'open', name: '打开 Workmap', callback: () => this.activateView() });
    this.addCommand({ id: 'new-period', name: '新建下一期时段笔记', callback: () => this.openNewPeriodModal() });
    this.addCommand({ id: 'today-section', name: '跳到今天的小节', callback: () => this.gotoToday() });
    this.addCommand({ id: 'new-note', name: '新建本期笔记', callback: () => this.withCurrentPeriod(p => this.promptNewNote(p.file)) });
    this.addCommand({ id: 'ai-review', name: 'AI 生成本期回顾', callback: () => this.withCurrentPeriod(p => this.aiReview(p)) });
    this.addCommand({ id: 'ai-quiz', name: 'AI 根据本期笔记出复习题', callback: () => this.withCurrentPeriod(p => this.aiQuiz(p)) });
    this.addCommand({ id: 'undo', name: '撤销上一步操作', callback: () => this.undo() });
    this.registerObsidianProtocolHandler('workmap', () => this.activateView());
    if (editorExt) this.registerEditorExtension(editorExt);
    this.addSettingTab(new MatrixSettingTab(this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshViews();
  }

  // 切时区只改显示，不写笔记。切完如果「今天」往后跳了，这一天先不自动顺延，
  // 否则点一下切换，没做完的任务就被改到了新日期，切回来也还原不了。
  async setZone(key, usZone = this.settings.usZone) {
    const before = zoneNow().startOf('day');
    this.settings.zone = key;
    this.settings.usZone = usZone;
    activeTz = zoneTz(key, usZone);
    const after = zoneNow().startOf('day');
    if (after.isAfter(before, 'day')) this.settings.carryHold = after.format('YYYY-MM-DD');
    else if (after.isBefore(before, 'day')) this.settings.carryHold = '';
    await this.saveSettings();
  }

  carryHeld(today) {
    return this.settings.carryHold === today.format('YYYY-MM-DD');
  }

  async releaseCarry() {
    this.settings.carryHold = '';
    await this.saveSettings();
  }

  // 只读：现在如果顺延，会搬哪些任务
  async pendingCarry(today) {
    const cur = this.periodFor(today);
    if (!cur) return [];
    const from = this.carryFrom();
    const read = async p => collectCarry(splitLines(await this.app.vault.read(p.file)).lines, p, today, from);
    const out = [];
    for (const p of this.olderPeriods(cur).reverse()) out.push(...await read(p));
    return [...out, ...await read(cur)];
  }

  // 顺延要看的更早各期，新的在前。设了顺延起点：起点之后结束的各期；没设：只看上一期。
  // 不能无条件扫所有往期：几年前没打勾的任务会全部被搬到今天
  olderPeriods(cur) {
    const older = this.periods().filter(p => p.endDate.isBefore(cur.startDate, 'day'));
    const from = this.carryFrom();
    return from ? older.filter(p => !p.endDate.isBefore(from, 'day')) : older.slice(0, 1);
  }

  carryFrom() {
    return parseDate(this.settings.carryStart || '');
  }

  // 命令用：视图正在看的那一期，没有就用今天所在的一期
  withCurrentPeriod(fn) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const p = (leaf && leaf.view && leaf.view.period) || this.periodFor(zoneNow());
    if (!p) {
      new Notice('今天还没有对应的时段笔记，先新建一期');
      return;
    }
    fn(p);
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

  async activateAgent() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(AGENT_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: AGENT_VIEW, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // 助理正显示在右侧边栏里：收起边栏；否则打开并切到助理
  async toggleAgent() {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(AGENT_VIEW)[0];
    const right = workspace.rightSplit;
    const el = leaf && leaf.view && leaf.view.containerEl;
    const shown = el && (typeof el.isShown === 'function' ? el.isShown() : el.offsetParent !== null);
    if (leaf && right && !right.collapsed && leaf.getRoot() === right && shown) {
      right.collapse();
      return;
    }
    await this.activateAgent();
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
    if (result && before !== after) {
      if (record) {
        this.history.push({ file, before, after, time: Date.now() });
        if (this.history.length > 30) this.history.shift();
      } else {
        this.autoWrites.set(file.path, Date.now());
      }
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
      const auto = this.autoWrites.get(h.file.path);
      new Notice(auto && auto > (h.time || 0)
        ? '这份笔记后来被自动顺延或「整理成笔记」改过，之前的操作已无法撤销'
        : '笔记在别处改过了，无法撤销');
    }
    return ok;
  }

  async updateMany(file, scope, items) {
    if (!items.length) return true;
    const pairs = [];
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
        pairs.push([task.raw, lines[idx]]);
      }
    });
    if (!ok) {
      new Notice('笔记内容刚刚变化过，已刷新，请再操作一次');
      this.refreshViews();
    } else {
      this.remapCarry(pairs);
    }
    return ok;
  }

  async updateTask(file, scope, task, patch) {
    let raw = null;
    const ok = await this.mutate(file, lines => {
      const r = rangeOf(lines, scope);
      const idx = r ? findRaw(lines, r, task.raw) : -1;
      if (idx < 0) return false;
      const kids = countChildren(lines, idx, r.end);
      if (patch === null) {
        lines.splice(idx, 1 + kids);
      } else if (patch.note !== undefined) {
        lines.splice(idx, 1 + kids, ...taskBlock(Object.assign({}, task, patch)));
        raw = lines[idx];
      } else {
        lines[idx] = formatTask(Object.assign({}, task, patch));
        raw = lines[idx];
      }
    });
    if (!ok) {
      new Notice('笔记内容刚刚变化过，已刷新，请再操作一次');
      this.refreshViews();
    } else if (raw !== null) {
      this.remapCarry([[task.raw, raw]]);
    }
    return ok;
  }

  // 顺延记录按行文本匹配。顺延来的任务被拖动、编辑、打勾后行文本会变，
  // 这里跟着改记录，「顺延」标签和顶部提示里的条目才不会消失
  remapCarry(pairs) {
    const c = this.settings.carry;
    if (!c || !Array.isArray(c.items)) return;
    let hit = false;
    for (const it of c.items) {
      const p = pairs.find(x => x[0] === it.raw && x[1] !== it.raw);
      if (p) {
        it.raw = p[1];
        hit = true;
      }
    }
    if (hit) this.saveData(this.settings);
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

  async addSection(file) {
    await this.mutate(file, lines => {
      if (periodRange(lines)) return false;
      lines.unshift('[🧭 打开 Workmap](obsidian://workmap)', '', '## 周期任务', '');
    });
  }

  // ----- 自动顺延 -----

  async carryOver(today) {
    if (this.carrying || this.carryHeld(today)) return 0;
    this.carrying = true;
    try {
      const cur = this.periodFor(today);
      if (!cur) return 0;
      const mode = this.settings.carryMode === 'move' ? 'move' : 'mark';
      const from = this.carryFrom();
      const { vault } = this.app;
      const peek = f => (vault.cachedRead ? vault.cachedRead(f) : vault.read(f));

      // 更早的各期里没做完的任务（中间有几天没建笔记也不会漏）。读出任务和标记原行放在同一次 vault.process 里，
      // 分成先 read 再写两步的话，中间笔记被改过时原行可能没标上，下次又会顺延一遍，出现重复。
      const touched = [];
      for (const p of this.olderPeriods(cur)) {
        if (!collectCarry(splitLines(await peek(p.file)).lines, p, today, from).length) continue;
        let items = [];
        await this.mutate(p.file, lines => {
          items = collectCarry(lines, p, today, from);
          if (!items.length) return false;
          markCarried(lines, items, mode);
        }, false);
        if (items.length) touched.unshift({ p, items });
      }
      const fromPrev = touched.flatMap(x => x.items);
      let fromCur = [];
      try {
        await this.mutate(cur.file, lines => {
          fromCur = collectCarry(lines, cur, today, from);
          if (!fromPrev.length && !fromCur.length) return false;
          markCarried(lines, fromCur, mode);
          insertTaskBlock(lines, ensureDay(lines, today.date()), [...fromPrev, ...fromCur].flatMap(it => it.block));
        }, false);
      } catch (e) {
        // 本期没写进去：把更早各期改过的地方还原，任务不能丢
        console.error('[workmap] 顺延失败', e);
        for (const { p, items } of touched) {
          await this.mutate(p.file, lines => unmarkCarried(lines, items, mode), false);
        }
        new Notice('自动顺延失败，详情见开发者控制台');
        return 0;
      }
      const total = fromPrev.length + fromCur.length;
      if (!total) return 0;

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

  // ----- 周期任务排序 -----

  async movePeriodTask(file, task, before) {
    const ok = await this.mutate(file, lines => {
      const r = periodRange(lines);
      if (!r || !moveTaskBlock(lines, r, task.raw, before ? before.raw : '')) return false;
    });
    if (!ok) {
      new Notice('笔记内容刚刚变化过，已刷新，请再操作一次');
      this.refreshViews();
    }
    return ok;
  }

  // ----- 本期笔记 -----

  notesFolder(p) {
    return p.file.path.replace(/\.md$/, '');
  }

  // 本期的笔记：「## 本期笔记」里的链接在前（按列表顺序），文件夹里没登记的文件放后面
  notesOf(p, lines) {
    const { metadataCache, vault } = this.app;
    const out = [];
    const seen = new Set();
    for (const l of listNoteLinks(lines)) {
      const f = metadataCache.getFirstLinkpathDest(l.link, p.file.path);
      if (f && seen.has(f.path)) continue;
      if (f) seen.add(f.path);
      out.push({ file: f || null, title: l.title || (f ? f.basename : l.link), link: l, listed: true });
    }
    const folder = vault.getAbstractFileByPath(this.notesFolder(p));
    if (folder && folder.children) {
      for (const f of folder.children) {
        if (!(f instanceof TFile) || f.extension !== 'md' || seen.has(f.path)) continue;
        out.push({ file: f, title: f.basename, link: null, listed: false });
      }
    }
    return out;
  }

  // fileManager.trashFile 按用户的回收站设置处理；老版本没有就放进系统回收站
  async trash(file) {
    const fm = this.app.fileManager;
    if (fm && typeof fm.trashFile === 'function') return fm.trashFile(file);
    return this.app.vault.trash(file, true);
  }

  async ensureFolder(path) {
    const { vault } = this.app;
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (!vault.getAbstractFileByPath(sub)) await vault.createFolder(sub);
    }
  }

  async uniquePath(folder, name) {
    const { vault } = this.app;
    let path = `${folder}/${name}.md`;
    for (let n = 2; vault.getAbstractFileByPath(path); n++) path = `${folder}/${name} ${n}.md`;
    return path;
  }

  // 新建一篇笔记文件，并登记到时段笔记的「## 本期笔记」里
  async createNote(period, title, content) {
    const folder = this.notesFolder(period);
    await this.ensureFolder(folder);
    const name = safeFileName(title);
    const path = await this.uniquePath(folder, name);
    const file = await this.app.vault.create(path, content);
    await this.mutate(period.file, lines => addNoteLink(lines, noteLinkLine(path, name)));
    return file;
  }

  promptNewNote(periodFile) {
    const p = this.periods().find(x => x.file.path === periodFile.path);
    if (!p) return;
    new NameModal(this, '新建本期笔记', '学习笔记、会议记录之类的长内容。会单独存成一个文件，放在这一期的文件夹里。', async title => {
      const file = await this.createNote(p, title, `# ${title}\n\n`);
      await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
    }).open();
  }

  async linkNote(period, file) {
    await this.mutate(period.file, lines => addNoteLink(lines, noteLinkLine(file.path, file.basename)));
  }

  async unlinkNote(period, link) {
    await this.mutate(period.file, lines => {
      const r = notesRange(lines);
      const idx = r ? findRaw(lines, r, link.raw) : -1;
      if (idx < 0) return false;
      lines.splice(idx, 1);
    });
  }

  // 把粘贴在时段笔记里、不属于任何小节的内容拆成单独的笔记。原文挪到新文件里，时段笔记里只留链接。
  // 先建好文件再改时段笔记；改的时候笔记已经变了就放弃，并删掉刚建的文件。不进撤销历史（撤销只会还原时段笔记，留下重复的文件）
  async archiveStray(period) {
    const { vault } = this.app;
    const before = await vault.read(period.file);
    const taken = takeStray(splitLines(before).lines);
    if (!taken.length) return 0;
    const folder = this.notesFolder(period);
    await this.ensureFolder(folder);
    const made = [];
    try {
      for (const t of taken) {
        const path = await this.uniquePath(folder, t.title);
        made.push({ file: await vault.create(path, t.text), title: path.split('/').pop().replace(/\.md$/, '') });
      }
    } catch (e) {
      for (const m of made) await this.trash(m.file);
      throw e;
    }
    let same = false;
    await vault.process(period.file, data => {
      if (data !== before) return data;
      same = true;
      const { lines, eol } = splitLines(data);
      takeStray(lines);
      for (const m of made) addNoteLink(lines, noteLinkLine(m.file.path, m.title));
      return lines.join(eol);
    });
    if (!same) {
      for (const m of made) await this.trash(m.file);
      new Notice('笔记内容刚刚变化过，已刷新，请再操作一次');
      this.refreshViews();
      return 0;
    }
    this.autoWrites.set(period.file.path, Date.now());
    new Notice(`已整理成 ${made.length} 篇本期笔记：${made.map(m => m.title).join('、')}`);
    return made.length;
  }

  // ----- 大模型 -----

  async readNotes(period, lines, only) {
    const list = only ? [only] : this.notesOf(period, lines).filter(n => n.file);
    const out = [];
    let budget = 60000;
    for (const n of list) {
      const f = n.file;
      const cache = this.app.metadataCache.getFileCache(f);
      const kind = cache && cache.frontmatter && cache.frontmatter.workmap;
      if (!only && (kind === 'ai-review' || kind === 'ai-quiz')) continue; // 以前生成的回顾、复习题不再喂回去
      let text = (await this.app.vault.cachedRead(f)).replace(/^---\n[\s\S]*?\n---\n/, '');
      if (text.length > 20000) text = text.slice(0, 20000) + '\n…（后面省略）';
      if (text.length > budget) text = text.slice(0, budget) + '\n…（后面省略）';
      budget -= text.length;
      out.push({ title: n.title, text });
      if (budget <= 0) break;
    }
    return out;
  }

  async chat(system, user) {
    const s = this.settings;
    if (!s.aiKey) throw new Error('还没有填写 API 密钥（设置 → Workmap → 大模型）');
    const base = (s.aiBase || DEFAULT_SETTINGS.aiBase).replace(/\/+$/, '');
    const res = await (this._request || requestUrl)({
      url: `${base}/chat/completions`,
      method: 'POST',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${s.aiKey}` },
      body: JSON.stringify({
        model: s.aiModel || DEFAULT_SETTINGS.aiModel,
        max_tokens: 8000,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      throw: false,
    });
    let data = null;
    try {
      data = res.json;
    } catch (e) {
      data = null;
    }
    if (res.status >= 400 || !data) throw new Error(httpErrorText(res.status, data && data.error && data.error.message));
    const c = data.choices && data.choices[0];
    const text = c && c.message && typeof c.message.content === 'string' ? c.message.content.trim() : '';
    if (!text) throw new Error('模型没有返回内容');
    return { text, model: data.model || s.aiModel, truncated: c.finish_reason === 'length' };
  }

  async runAI(kind, label, makePrompt, period, title) {
    if (this.aiBusy) {
      new Notice('上一个 AI 任务还在生成，请稍等');
      return null;
    }
    this.aiBusy = true;
    this.refreshViews();
    const notice = new Notice(`正在用 ${this.settings.aiModel} ${label}，通常要半分钟到两分钟…`, 0);
    try {
      const lines = splitLines(await this.app.vault.read(period.file)).lines;
      const prompt = await makePrompt(lines);
      if (!prompt) return null;
      const r = await this.chat(prompt.system, prompt.user);
      const now = zoneNow();
      const body = [
        '---',
        `workmap: ${kind}`,
        `model: ${r.model}`,
        `created: ${now.format('YYYY-MM-DD HH:mm')}`,
        '---',
        '',
        `# ${title}`,
        '',
        `> 由 ${r.model} 根据 [[${period.file.path.replace(/\.md$/, '')}|${period.label}]] 生成于 ${now.format('M/D HH:mm')}`,
        '',
        r.text,
        r.truncated ? '\n> [!warning] 输出达到长度上限，后面可能被截断了。' : '',
        '',
      ].join('\n');
      const file = await this.createNote(period, `${title} ${now.format('M-D HHmm')}`, body);
      await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
      return file;
    } catch (e) {
      console.error('[workmap] AI 请求失败', e);
      new Notice(`${label}失败：${e.message || e}`, 10000);
      return null;
    } finally {
      notice.hide();
      this.aiBusy = false;
      this.refreshViews();
    }
  }

  // ----- 工作助理 -----

  async agentContextFor(flags) {
    const now = zoneNow();
    const read = async x => (x ? { p: x, lines: splitLines(await this.app.vault.cachedRead(x.file)).lines } : null);
    const p = this.periodFor(now);
    const cur = await read(p);
    const yp = this.periodFor(now.clone().subtract(1, 'day'));
    const prev = yp && p && yp.file.path === p.file.path ? cur : await read(yp);
    const notes = flags.notes && cur ? await this.readNotes(p, cur.lines) : [];
    return agentContext({ now, cur, prev, flags, notes });
  }

  // 流式调用：每收到一段就 onDelta(累计结果)。fetch 不可用或失败时退回一次性请求
  async streamChat(o) {
    const { model, effort, system, messages, signal, onDelta } = o;
    const s = this.settings;
    if (!s.aiKey) throw new Error('还没有填写 API 密钥（设置 → Workmap → 大模型）');
    const api = agentModel(model).api;
    const req = buildChatRequest({ base: s.aiBase, key: s.aiKey, model, effort, system, messages, stream: true });
    const acc = { text: '', thinking: '', usage: null };
    const doFetch = this._fetch || (typeof fetch === 'function' ? fetch.bind(window) : null);
    let res = null;
    if (doFetch) {
      try {
        res = await doFetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn('[workmap] 流式请求失败，改用一次性请求', e);
        res = null;
      }
    }
    if (res && !res.ok) {
      const t = await res.text();
      let msg = '';
      try {
        msg = JSON.parse(t).error.message;
      } catch (e) {
        msg = t.slice(0, 200);
      }
      throw new Error(httpErrorText(res.status, msg));
    }
    if (!res || !res.body) {
      const once = buildChatRequest({ base: s.aiBase, key: s.aiKey, model, effort, system, messages, stream: false });
      const r = await (this._request || requestUrl)({ url: once.url, method: 'POST', headers: once.headers, body: JSON.stringify(once.body), throw: false });
      let data = null;
      try {
        data = r.json;
      } catch (e) {
        data = null;
      }
      if (r.status >= 400 || !data) throw new Error(httpErrorText(r.status, data && data.error && data.error.message));
      Object.assign(acc, replyOf(api, data));
      if (onDelta) onDelta(acc);
      return acc;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const feed = events => {
      let changed = false;
      for (const ev of events) {
        const d = streamDelta(api, ev);
        if (d.error) throw new Error(d.error);
        if (d.text || d.thinking) changed = true;
        acc.text += d.text;
        acc.thinking += d.thinking;
        if (d.usage) {
          acc.usage = Object.assign({}, acc.usage);
          for (const [k, v] of Object.entries(d.usage)) if (v !== undefined && v !== '') acc.usage[k] = v;
        }
      }
      if (changed && onDelta) onDelta(acc);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const r = sseSplit(buf);
      buf = r.rest;
      feed(r.events);
    }
    feed(sseSplit(buf + '\n').events);
    return acc;
  }

  // 执行助理建议、用户确认过的一条改动。只改今天的任务；出错时抛出原因
  async applyAction(a) {
    const today = zoneNow().startOf('day');
    const p = this.periodFor(today);
    if (!p) throw new Error('今天没有对应的时段笔记');
    const lines = splitLines(await this.app.vault.read(p.file)).lines;
    const pr = periodRange(lines);
    const pts = pr ? collectTasks(lines, pr, 'period') : [];
    const d = dayRange(lines, today.date());
    const tasks = d ? collectTasks(lines, d, 'day') : [];
    const q = clamp(Math.round(+a.quad) || 1, 1, 4);
    if (a.op === 'add') {
      const text = String(a.text || '').trim();
      if (!text) throw new Error('缺少任务内容');
      let parent = '';
      const pt = a.parent ? matchTask(pts, String(a.parent)) : null;
      if (pt) parent = (await this.ensurePeriodId(p.file, pt)) || '';
      await this.addDayTask(p.file, today.date(), Object.assign({ text, done: false, parent, note: a.note ? String(a.note) : '' }, endPos(tasks, q)));
      return;
    }
    if (a.op === 'addPeriod') {
      const text = String(a.text || '').trim();
      if (!text) throw new Error('缺少主线内容');
      await this.addPeriodTask(p.file, {
        text,
        level: clamp(Math.round(+a.level) || 0, 0, 3),
        due: parseDate(String(a.due || '')) ? a.due : '',
        done: false,
        id: newId(),
        note: '',
      });
      return;
    }
    const t = matchTask(tasks, String(a.task || ''));
    if (!t) throw new Error(`今天的任务里找不到「${a.task}」`);
    if (a.op === 'slot' && !this.settings.slots.includes(a.slot)) throw new Error(`没有「${a.slot}」这个时段`);
    const patch = {
      done: { done: true },
      doing: { doing: true, done: false, cancelled: false },
      cancel: { done: true, cancelled: true, doing: false },
      move: endPos(tasks.filter(x => x !== t), q),
      slot: { slot: a.slot },
    }[a.op];
    if (!patch) throw new Error(`不支持的操作 ${a.op}`);
    if (!(await this.updateTask(p.file, { kind: 'day', day: today.date() }, t, patch))) throw new Error('笔记刚刚变化过，请再点一次');
  }

  // 对话存在今天所在一期的「对话」文件夹里；没有时段笔记就不存
  async saveChat(chat) {
    const text = formatChat(chat);
    const { vault } = this.app;
    if (chat.file && vault.getAbstractFileByPath(chat.file.path)) {
      await vault.modify(chat.file, text);
      return chat.file;
    }
    const p = this.periodFor(zoneNow());
    if (!p) return null;
    const folder = `${this.notesFolder(p)}/${CHAT_DIR}`;
    await this.ensureFolder(folder);
    const when = moment(chat.created, 'YYYY-MM-DD HH:mm');
    const path = await this.uniquePath(folder, `${when.isValid() ? when.format('MM-DD HHmm') : ''} ${chat.title}`.trim());
    chat.file = await vault.create(path, text);
    return chat.file;
  }

  listChats() {
    const re = new RegExp(`^\\d{4}/\\d{1,2}/\\d{1,2}-\\d{1,2}/${CHAT_DIR}/`);
    return this.app.vault.getMarkdownFiles().filter(f => re.test(f.path)).sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  aiReview(period) {
    return this.runAI('ai-review', '生成本期回顾', async lines => ({
      system: AI_REVIEW_PROMPT,
      user: periodDigest({ p: period, lines, today: zoneNow().startOf('day'), notes: await this.readNotes(period, lines) }),
    }), period, 'AI 回顾');
  }

  // only：只根据某一篇笔记出题
  aiQuiz(period, only) {
    return this.runAI('ai-quiz', '出复习题', async lines => {
      const notes = await this.readNotes(period, lines, only);
      if (!notes.length || !notes.some(n => n.text.trim().length > 20)) {
        new Notice('本期还没有可以出题的笔记。先在「本期笔记」里记一些内容');
        return null;
      }
      return {
        system: AI_QUIZ_PROMPT,
        user: notes.map(n => `# 《${n.title}》\n\n${n.text.trim()}`).join('\n\n'),
      };
    }, period, only ? `复习题 · ${only.title}` : '复习题');
  }

  // ----- 新建时段笔记 -----

  openNewPeriodModal() {
    const { start, end } = suggestPeriod(zoneNow().startOf('day'), this.periods());
    new NewPeriodModal(this, start, end).open();
  }

  async loadTemplate() {
    const f = this.app.vault.getAbstractFileByPath(TEMPLATE_PATH);
    if (f instanceof TFile) return this.app.vault.read(f);
    return DEFAULT_TEMPLATE;
  }

  // 迁移周期任务要用的上一期：新一期开始之前最近的那一期
  migrationSource(start) {
    return this.periods().find(p => p.startDate.isBefore(start, 'day')) || null;
  }

  // 上一期还没结束就提前建下一期：现在迁移会把这一期的主线搬空，所以推迟到新一期开始那天
  migrationDeferred(source, today) {
    return !!source && !today.isAfter(source.endDate, 'day');
  }

  async createPeriod(start, end, migrate) {
    const { vault } = this.app;
    const problem = periodProblem(start, end, this.periods());
    if (problem) {
      new Notice(problem);
      return null;
    }

    const folder = `${start.year()}/${pad(start.month() + 1)}`;
    const path = `${folder}/${start.date()}-${end.date()}.md`;
    const today = zoneNow().startOf('day');

    let moved = [];
    const source = migrate ? this.migrationSource(start) : null;
    const defer = this.migrationDeferred(source, today);
    if (source && !defer) moved = openPeriodBlocks(splitLines(await vault.read(source.file)).lines);

    const inRange = !today.isBefore(start, 'day') && !today.isAfter(end, 'day');
    const day = pad(inRange ? today.date() : start.date());
    const content = fillTemplate(await this.loadTemplate(), moved.map(m => m.block), day);

    if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    const file = await vault.create(path, content);

    if (moved.length) await this.mutate(source.file, lines => removePeriodBlocks(lines, moved));
    if (defer) {
      this.settings.migrations = (this.settings.migrations || []).filter(m => m.to !== path);
      this.settings.migrations.push({ from: source.file.path, to: path });
      await this.saveData(this.settings);
      new Notice(`已创建 ${path}。${source.label} 还没结束，到 ${start.month() + 1}/${start.date()} 新一期开始时，再把那时没完成的周期任务移过去`, 8000);
    } else {
      new Notice(`已创建 ${path}` + (moved.length ? `，从 ${source.label} 迁移了 ${moved.length} 个周期任务` : ''));
    }
    return file;
  }

  // 新一期开始了：执行之前推迟的迁移。返回迁移了几个周期任务
  async runMigrations(today) {
    const list = this.settings.migrations || [];
    if (!list.length || this.migrating) return 0;
    this.migrating = true;
    let total = 0;
    try {
      const periods = this.periods();
      const keep = [];
      for (const m of list) {
        const to = periods.find(p => p.file.path === m.to);
        const from = periods.find(p => p.file.path === m.from);
        if (!to || !from) continue; // 文件没了，这条作废
        if (today.isBefore(to.startDate, 'day')) {
          keep.push(m);
          continue;
        }
        const blocks = openPeriodBlocks(splitLines(await this.app.vault.read(from.file)).lines);
        let added = 0;
        if (blocks.length) {
          await this.mutate(to.file, lines => {
            added = insertPeriodBlocks(lines, blocks);
            if (!added) return false;
          }, false);
          // 加进新一期的才从旧的一期删掉；已经在新一期里的（同编号）也删掉，免得两边都挂着
          await this.mutate(from.file, lines => removePeriodBlocks(lines, blocks), false);
        }
        total += blocks.length;
        if (blocks.length) new Notice(`新的一期开始了：从 ${from.label} 迁移了 ${blocks.length} 个没完成的周期任务`);
      }
      if (keep.length !== list.length) {
        this.settings.migrations = keep;
        await this.saveData(this.settings);
      }
    } finally {
      this.migrating = false;
    }
    return total;
  }

  pendingMigration(path) {
    return (this.settings.migrations || []).find(m => m.to === path || m.from === path) || null;
  }

  async gotoToday() {
    const today = zoneNow();
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
    this.notes = [];
    this.lines = [];
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
    this.spaceEl = null;
    this.gradSeq = 0;
    this.galaxy = null;
    this.riverRO = null;
    this.riverRaf = 0;
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
    // 本期笔记改了（预览、AI 生成的标记）：慢一点刷新，别在另一个窗格打字时频繁重建视图
    this.registerEvent(this.app.metadataCache.on('changed', f => {
      if (!this.period || !f.path.startsWith(this.plugin.notesFolder(this.period) + '/')) return;
      if (f.path.includes(`/${CHAT_DIR}/`)) return;
      window.clearTimeout(this.noteTimer);
      this.noteTimer = window.setTimeout(() => this.requestRefresh(), 2000);
    }));
    this.registerInterval(window.setInterval(() => this.requestRefresh(), 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.meteor(), 6000));
    this.registerInterval(window.setInterval(() => this.tickClock(), 10000));
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
    window.clearTimeout(this.noteTimer);
    window.clearTimeout(this.toastTimer);
    if (this.toastEl) this.toastEl.remove();
    if (this.fxEl) this.fxEl.remove();
    if (this.riverRaf) window.cancelAnimationFrame(this.riverRaf);
    if (this.riverRO) this.riverRO.disconnect();
    if (this.spaceEl) this.spaceEl.remove();
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

  // 时钟每 10 秒走一次；跨小时、跨天时刷新，「今天」和当前时段才跟得上
  tickClock() {
    if (this.clockEl && this.clockEl.isConnected) this.clockEl.setText(zoneNow().format('HH:mm'));
    const key = zoneNow().format('YYYY-MM-DD HH');
    if (this.clockKey && key !== this.clockKey && !this.dragging) this.requestRefresh();
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
    const today = zoneNow().startOf('day');
    if (today.isBefore(p.startDate, 'day')) return p.start;
    if (today.isAfter(p.endDate, 'day')) return p.endDate.date();
    return today.date();
  }

  buildStatsCard(grid) {
    const p = this.period;
    const s = periodStats({
      periodTasks: this.periodTasks,
      allDaily: this.allDaily,
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
    cell(`${s.activeDays} 天`, '有完成的日子');
    cell(s.bestRun ? `${s.bestRun} 天` : '—', '最长连续');
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
    const today = zoneNow().startOf('day');
    this.clockKey = zoneNow().format('YYYY-MM-DD HH');
    // 正在看的那天因为切时区或跨天变成了今天，就回到跟随今天
    if (!this.follow && this.dayDate && this.dayDate.isSame(today, 'day')) {
      this.follow = true;
      this.selectedPath = null;
      this.dayDate = null;
    }
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

    if (this.follow && await this.plugin.runMigrations(today)) {
      this.again = true;
      return;
    }

    let held = [];
    if (this.period && this.follow && this.day.isSame(today, 'day')) {
      if (this.plugin.carryHeld(today)) {
        if (this.holdSkipped !== today.format('YYYY-MM-DD')) held = await this.plugin.pendingCarry(today);
      } else {
        const moved = await this.plugin.carryOver(today);
        if (moved) {
          this.again = true;
          return;
        }
      }
    }

    let lines = null;
    if (this.file) lines = splitLines(await this.app.vault.read(this.file)).lines;

    const el = this.contentEl;
    const scroll = el.scrollTop;
    el.empty();
    applySkin(el, this.plugin);
    this.buildSpace();
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
    // 拖了几天：有 %%c%% 用它，老的顺延任务往前找同名的 [>]
    for (const t of this.dayTasks) {
      if (t.done) continue;
      const since = t.since || chainOrigin(lines, this.period, t.text, t.day);
      t.age = since ? carryAge(since, this.day) : 0;
      t.origin = since;
    }
    this.lines = lines;
    this.notes = this.plugin.notesOf(this.period, lines);
    const stray = strayBlocks(lines);

    const carry = this.settings.carry;
    const showCarry = this.follow && this.day.isSame(today, 'day') && carry && carry.date === today.format('YYYY-MM-DD');
    this.carried = new Set(showCarry ? carry.items.map(i => i.raw) : []);

    this.buildHero(el, periods, today);
    if (held.length) this.buildCarryHold(el, held, today);
    if (showCarry && !carry.dismissed) this.buildCarry(el, carry);
    if (stray.length) this.buildStray(el, lines, stray);
    this.buildPeriodSection(el);
    this.buildDayHead(el, today);
    this.buildComposer(el);
    const main = el.createDiv('pm-main');
    this.buildBoard(main);
    this.buildTimeline(main, today);
    this.buildTray(el);
    this.buildNotes(el);
    if (!this.settings.hideTips) this.buildTips(el);
    el.scrollTop = scroll;
    this.placeRivers();
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
      // 进度线放在 rail 里，在月亮的位置挖一个洞，月牙的凹口里才不会有线穿过
      const rail = track.createDiv('pm-pprog-rail');
      rail.createDiv('pm-pprog-line').createDiv('pm-pprog-fill').style.width = (nth / total * 100) + '%';
      const sel = clamp(day.diff(p.startDate, 'days'), 0, total - 1);
      const moonX = ((sel + 0.5) / total * 100) + '%';
      rail.style.setProperty('--pm-moon-x', moonX);
      const mark = track.createDiv('pm-pprog-mark');
      mark.style.left = moonX;
      let text;
      if (today.isBefore(p.startDate, 'day')) text = `${p.startDate.diff(today, 'days')} 天后开始 · 共 ${total} 天`;
      else if (today.isAfter(p.endDate, 'day')) text = `本期已结束 · 共 ${total} 天`;
      else text = `第 ${nth} / ${total} 天 · 还剩 ${total - nth} 天`;
      prog.createSpan({ cls: 'pm-pprog-text', text });
    }

    const side = hero.createDiv('pm-hero-side');
    this.buildZone(side);
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
    iconBtn(acts, 'bot', '工作助理').onclick = () => this.plugin.toggleAgent();
    const open = iconBtn(acts, 'file-text', '打开笔记');
    open.disabled = !this.file;
    open.onclick = () => this.plugin.openFileAtLine(this.file, 0);
    textBtn(acts, '新建下一期', '', 'plus').onclick = () => this.plugin.openNewPeriodModal();
  }

  buildZone(side) {
    const box = side.createDiv('pm-zone');
    const seg = box.createDiv({ cls: 'pm-seg', attr: { role: 'group', 'aria-label': '时区' } });
    const { zone, usZone } = this.settings;
    const date = new Date();
    for (const z of ZONES) {
      const tz = zoneTz(z.key, usZone);
      const on = z.key === zone;
      const b = seg.createEl('button', {
        cls: 'pm-zone-btn' + (on ? ' is-on' : ''),
        text: z.label,
        attr: {
          'aria-pressed': String(on),
          'aria-label': `${z.label} ${momentIn(date, tz).format('HH:mm')} ${utcOffsetLabel(date, tz)}`,
        },
      });
      if (!on) b.onclick = () => this.plugin.setZone(z.key);
    }
    this.clockEl = box.createSpan({ cls: 'pm-zone-clock', text: zoneNow().format('HH:mm') });
    if (zone === 'us') {
      const u = US_ZONES.find(x => x[0] === usZone);
      box.createSpan({ cls: 'pm-zone-sub', text: u ? u[1] : '' });
    }
    if (!zone) box.createSpan({ cls: 'pm-zone-sub', text: '系统时间' });
  }

  goDay(d) {
    const p = this.plugin.periodFor(d);
    if (!p) return;
    if (d.isSame(zoneNow(), 'day')) {
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

  // 切时区后到了新的一天：没做完的任务先留在原处，由用户决定要不要顺延
  buildCarryHold(el, items, today) {
    const box = el.createDiv('pm-carry');
    const head = box.createDiv('pm-carry-head');
    setIcon(head.createSpan('pm-carry-icon'), 'history');
    const txt = head.createDiv('pm-carry-text');
    txt.createSpan({ cls: 'pm-carry-title', text: `换时区后到了 ${today.month() + 1}/${today.date()}，之前还有 ${items.length} 项没做完` });
    txt.createSpan({ cls: 'pm-carry-sub', text: items.slice(0, 3).map(i => i.info.text).join('、') + (items.length > 3 ? ' …' : '') });
    head.createDiv('pm-spacer');
    textBtn(head, '先不', 'is-ghost').onclick = () => {
      this.holdSkipped = today.format('YYYY-MM-DD');
      this.refresh();
    };
    textBtn(head, '顺延到今天', 'is-primary').onclick = () => this.plugin.releaseCarry();
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
    this.pgrid = grid;
    if (this.periodTasks.length && this.periodTasks.every(t => t.done)) this.buildStatsCard(grid);
    else this.stats = null;
    // 顺序就是笔记里的顺序（拖动卡片调整），已完成的放最后。重要程度看星标和左边的色条
    const tasks = this.periodTasks
      .filter(t => !(this.settings.hideDone && t.done))
      .sort((a, b) => (a.done - b.done) || (a.line - b.line));
    for (const t of tasks) grid.appendChild(this.makePeriodCard(t));
    if (!tasks.length && !this.periodTasks.length) {
      const add = grid.createDiv('pm-pcard is-add');
      const mig = this.plugin.pendingMigration(this.file.path);
      add.createSpan({
        text: mig && mig.to === this.file.path
          ? `＋ 添加主线 · 上一期没完成的主线会在 ${this.period.month}/${this.period.start} 自动移过来`
          : '＋ 添加这一期要推进的主线',
      });
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
    card.dataset.line = String(t.line);
    if (t.done) card.addClass('is-done');
    if (t.cancelled) card.addClass('is-cancelled');
    if (t.doing) card.addClass('is-doing');
    const scope = { kind: 'period' };
    const upd = patch => this.plugin.updateTask(this.file, scope, t, patch);

    const head = card.createDiv('pm-pcard-head');
    const chk = buildCheck(head, t.done, (v, el) => this.setDone(scope, t, v, el));
    if (this.popMatch(t)) this.replayPop(chk, card);
    buildStars(head, t.level, v => upd({ level: v }));
    if (t.level) head.createSpan({ cls: 'pm-level-tag', text: LEVEL_NAMES[t.level] });
    head.createDiv('pm-spacer');
    if (t.doing) head.createSpan({ cls: 'pm-pill is-doing', text: '进行中' });
    if (t.cancelled) head.createSpan({ cls: 'pm-pill', text: '已取消' });
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

    const linked = t.id ? this.allDaily.filter(d => d.parent === t.id && !d.cancelled) : [];
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
      this.statusItems(menu, t, upd);
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
      psel.createEl('option', { value: t.raw, text: `↳ ${t.level ? '★'.repeat(t.level) + ' ' : ''}${t.text}` });
    }
    psel.value = this.periodTasks.some(p => p.raw === this.lastParent) ? this.lastParent : '';
    psel.onchange = () => { this.lastParent = psel.value; };

    tools.createDiv('pm-spacer');
    const send = iconBtn(tools, 'arrow-up', '添加', 'pm-send');

    // 写入和重新渲染之间输入框里还留着旧文字，快速连按回车会加出重复的任务，
    // 所以提交时先清空输入框，并且同一时间只处理一次提交
    let sending = false;
    const submit = async () => {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      input.value = '';
      this.draft = '';
      const restore = () => {
        if (!input.value) input.value = text;
        this.draft = input.value;
      };
      try {
        let parent = '';
        const pt = this.periodTasks.find(p => p.raw === psel.value);
        if (pt) {
          parent = await this.plugin.ensurePeriodId(this.file, pt);
          if (!parent) {
            restore();
            return;
          }
          this.lastParent = formatTask(Object.assign({}, pt, { id: parent }));
        }
        this.focusInput = true;
        await this.plugin.addDayTask(this.file, this.day.date(), Object.assign({
          text,
          done: false,
          parent,
        }, endPos(this.dayTasks, +this.lastQuad)));
      } catch (e) {
        restore();
        throw e;
      } finally {
        sending = false;
      }
    };
    input.addEventListener('keydown', e => {
      if (isSubmitKey(e)) submit();
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
    if (this.riverRO) this.riverRO.disconnect();
    this.riverRO = null;
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
    if (this.sky) {
      this.riverRO = new ResizeObserver(() => this.queuePlaceRivers());
      this.riverRO.observe(board);
      for (const qd of board.children) this.riverRO.observe(qd);
    }
  }

  // ----- 星空 -----

  buildSky(qd, q) {
    const sky = qd.createDiv('pm-sky');
    this.skyLayers[q] = sky;
    if (q === 3) sky.createDiv('pm-sky-moon');
    if (q === 2) sky.createDiv('pm-sky-venus');
    if (q === 1 || q === 2) {
      for (let i = 0; i < 2; i++) sky.createDiv('pm-sky-cloud').style.setProperty('--i', String(i));
    }
    const dust = sky.createDiv('pm-sky-dust');
    this.fillDust(dust, hashStr(`${this.file.path}|${q}`), 46);
    this.buildRiver(sky);

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
      const el = sky.createDiv({ cls: 'pm-skystar' + (s.today ? ' is-today' : '') });
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

  fillDust(el, seed, n) {
    for (const d of dustLayout(seed, n)) {
      const s = el.createSpan((d.big || d.glint ? 'is-big' : '') + (d.tw || d.glint ? ' is-tw' : '') + (d.glint ? ' is-glint' : ''));
      s.style.setProperty('--dur', d.dur + 's');
      if (d.glint) s.createSpan('pm-star-spark');
      s.style.left = d.x + '%';
      s.style.top = d.y + '%';
      s.style.setProperty('--o', String(d.o));
      s.style.setProperty('--d', d.d + 's');
    }
  }

  // 整页的深空背景：放在内容后面，不随滚动移动
  buildSpace() {
    const host = this.containerEl;
    const on = !!this.settings.sky;
    host.toggleClass('pm-has-space', on);
    if (!on) {
      if (this.spaceEl) this.spaceEl.remove();
      this.spaceEl = null;
      return;
    }
    if (!this.spaceEl || !this.spaceEl.isConnected) {
      this.spaceEl = createDiv('pm-space-bg');
      host.insertBefore(this.spaceEl, this.contentEl);
      this.spaceEl.createDiv('pm-space-nebula');
      this.fillDust(this.spaceEl.createDiv('pm-sky-dust'), hashStr('workmap|space'), 200);
    }
    applySkin(this.spaceEl, this.plugin);
    this.spaceEl.style.top = this.contentEl.offsetTop + 'px';
  }

  // 银河画在整张看板的坐标里，每个象限只显示经过自己的那一段
  buildRiver(sky) {
    if (!this.galaxy || this.galaxy.key !== this.file.path) {
      this.galaxy = { key: this.file.path, data: galaxyLayout(hashStr(`galaxy|${this.file.path}`)), img: null, imgKey: '' };
    }
    sky.createEl('canvas', { cls: 'pm-galaxy' });
    const box = sky.createDiv('pm-river');
    for (const b of this.galaxy.data.bright) {
      const el = box.createSpan('pm-rstar is-bright');
      el.dataset.tone = String(b.tone);
      el.style.setProperty('--sz', b.r + 'px');
      el.style.setProperty('--tw', b.tw + 's');
      el.style.setProperty('--dur', b.dur + 's');
      el.createSpan('pm-star-spark');
    }
  }

  placeRivers() {
    const b = this.board;
    if (!b || !b.isConnected || !this.galaxy) return;
    const br = b.getBoundingClientRect();
    const W = Math.round(br.width);
    const H = Math.round(br.height);
    if (W < 10 || H < 10) return;
    const dark = this.contentEl.hasClass('pm-dark');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const key = `${W}x${H}@${dpr}|${dark}`;
    const g = this.galaxy;
    if (g.imgKey !== key) {
      const r = renderGalaxy(g.data, W, H, dpr, dark);
      g.img = r.canvas;
      g.pos = r.bright;
      g.imgKey = key;
    }
    for (const sky of Object.values(this.skyLayers || {})) {
      const box = sky.querySelector('.pm-river');
      const cv = sky.querySelector('canvas.pm-galaxy');
      if (!box || !cv) continue;
      const sr = sky.getBoundingClientRect();
      const ox = br.left - sr.left;
      const oy = br.top - sr.top;
      box.style.left = ox + 'px';
      box.style.top = oy + 'px';
      box.style.width = W + 'px';
      box.style.height = H + 'px';
      box.querySelectorAll('.pm-rstar').forEach((el, i) => {
        const p = g.pos[i];
        el.style.left = p.x.toFixed(2) + '%';
        el.style.top = p.y.toFixed(2) + '%';
      });
      const cw = Math.max(1, Math.round(sr.width * dpr));
      const ch = Math.max(1, Math.round(sr.height * dpr));
      if (cv.width !== cw) cv.width = cw;
      if (cv.height !== ch) cv.height = ch;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(g.img, Math.round(ox * dpr), Math.round(oy * dpr));
    }
  }

  queuePlaceRivers() {
    if (this.riverRaf) return;
    this.riverRaf = window.requestAnimationFrame(() => {
      this.riverRaf = 0;
      this.placeRivers();
    });
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
    const first = [...kin].find(el => el.hasClass('pm-skystar'));
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
    if (Math.random() < 0.25) return;
    const skies = Object.values(this.skyLayers || {}).filter(s => s.isConnected);
    if (!skies.length) return;
    const bg = this.spaceEl && this.spaceEl.isConnected && Math.random() < 0.3;
    const sky = bg ? this.spaceEl : skies[Math.floor(Math.random() * skies.length)];
    const m = sky.createDiv('pm-meteor');
    m.style.left = (40 + Math.random() * 55) + '%';
    m.style.top = (Math.random() * 50) + '%';
    m.style.setProperty('--len', Math.round(60 + Math.random() * 70) + 'px');
    m.style.setProperty('--ang', Math.round(-22 - Math.random() * 22) + 'deg');
    m.style.setProperty('--dur', (0.8 + Math.random() * 0.6).toFixed(2) + 's');
    m.addEventListener('animationend', () => m.remove());
  }

  buildTimeline(parent, today) {
    const tl = parent.createDiv('pm-timeline');
    const head = tl.createDiv('pm-section-head');
    head.createEl('h3', { cls: 'pm-h3', text: '日程' });
    const n = this.dayTasks.filter(t => t.slot).length;
    head.createSpan({ cls: 'pm-count', text: n ? `${n} 项` : '点击时段添加' });
    const isToday = this.day.isSame(today, 'day');
    const hour = zoneHour();
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

  // ----- 游离内容 -----

  buildStray(el, lines, blocks) {
    const n = blocks.reduce((a, b) => a + b.end - b.start, 0);
    const box = el.createDiv('pm-carry pm-stray');
    const head = box.createDiv('pm-carry-head');
    setIcon(head.createSpan('pm-carry-icon'), 'file-text');
    const txt = head.createDiv('pm-carry-text');
    txt.createSpan({
      cls: 'pm-carry-title',
      text: `笔记里有 ${blocks.length} 段内容不属于任何小节（共 ${n} 行）`,
    });
    txt.createSpan({
      cls: 'pm-carry-sub',
      text: blocks.map(b => `《${strayTitle(lines.slice(b.start, b.end))}》`).join('、') + ' · 可以整理成单独的本期笔记，原文会完整挪过去',
    });
    head.createDiv('pm-spacer');
    textBtn(head, '定位', 'is-ghost').onclick = () => this.plugin.openFileAtLine(this.file, blocks[0].start);
    const go = textBtn(head, '整理成本期笔记', 'is-primary');
    go.onclick = async () => {
      go.disabled = true;
      try {
        await this.plugin.archiveStray(this.period);
      } finally {
        go.disabled = false;
      }
    };
  }

  // ----- 本期笔记 -----

  buildNotes(el) {
    const sec = el.createDiv('pm-section pm-notes');
    const head = sec.createDiv('pm-section-head');
    head.createEl('h2', { cls: 'pm-h2', text: '本期笔记' });
    head.createSpan({ cls: 'pm-count', text: this.notes.length ? `${this.notes.length} 篇` : '学习笔记、会议记录放在这里' });
    head.createDiv('pm-spacer');
    const busy = this.plugin.aiBusy;
    const quiz = textBtn(head, busy ? '生成中…' : 'AI 出题', 'is-ghost', 'graduation-cap');
    const review = textBtn(head, busy ? '生成中…' : 'AI 回顾', 'is-ghost', 'sparkles');
    quiz.disabled = busy;
    review.disabled = busy;
    quiz.title = '根据本期笔记出一套复习题，带折叠的参考答案';
    review.title = '把本期的主线、每天的任务、拖延情况和笔记交给大模型，写一份复盘';
    quiz.onclick = () => this.plugin.aiQuiz(this.period);
    review.onclick = () => this.plugin.aiReview(this.period);
    textBtn(head, '新建', 'is-ghost', 'plus').onclick = () => this.plugin.promptNewNote(this.file);

    const grid = sec.createDiv('pm-ngrid');
    for (const n of this.notes) grid.appendChild(this.makeNoteCard(n));
    if (!this.notes.length) {
      const add = grid.createDiv('pm-ncard is-add');
      add.createSpan({ text: '＋ 记一篇本期笔记' });
      add.onclick = () => this.plugin.promptNewNote(this.file);
    }
  }

  makeNoteCard(n) {
    const card = createDiv({ cls: 'pm-ncard' });
    const f = n.file;
    const cache = f ? this.app.metadataCache.getFileCache(f) : null;
    const kind = (cache && cache.frontmatter && cache.frontmatter.workmap) || '';
    if (kind) card.dataset.kind = kind;
    if (!f) card.addClass('is-missing');
    const head = card.createDiv('pm-ncard-head');
    setIcon(head.createSpan('pm-ncard-icon'), kind === 'ai-review' ? 'sparkles' : kind === 'ai-quiz' ? 'graduation-cap' : 'file-text');
    head.createDiv({ cls: 'pm-ncard-title', text: n.title });
    const preview = card.createDiv('pm-ncard-preview');
    const foot = card.createDiv('pm-ncard-foot');
    if (!f) {
      preview.setText(`找不到 ${n.link.link}`);
    } else {
      const m = moment(f.stat.mtime);
      foot.createSpan({ text: `${m.month() + 1}/${m.date()} 修改` });
      if (!n.listed) foot.createSpan({ cls: 'pm-ncard-tag', text: '未登记' }).title = '在本期文件夹里，但没写进「## 本期笔记」。右键可以登记';
      // 预览异步补上，不挡住整页渲染
      this.app.vault.cachedRead(f).then(text => {
        const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
        const lines = body.split('\n')
          .map(l => l.trim())
          .filter(l => l && !/^(#{1,6}\s|---|>\s*由 |\|)/.test(l));
        preview.setText(lines.slice(0, 3).join(' ').replace(/[*`>#]/g, '').slice(0, 120));
        foot.createSpan({ text: `约 ${body.replace(/\s/g, '').length} 字` });
      });
    }
    const open = how => f && this.app.workspace.getLeaf(how).openFile(f, { active: true });
    card.onclick = e => open(e.metaKey || e.ctrlKey ? 'split' : 'tab');
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      const menu = new Menu();
      if (f) {
        menu.addItem(i => i.setTitle('在新标签页打开').setIcon('file').onClick(() => open('tab')));
        menu.addItem(i => i.setTitle('在右侧打开').setIcon('columns').onClick(() => open('split')));
        if (!kind) {
          menu.addItem(i => i.setTitle('AI 根据这篇出题').setIcon('graduation-cap')
            .onClick(() => this.plugin.aiQuiz(this.period, n)));
        }
        menu.addSeparator();
      }
      if (n.listed) {
        menu.addItem(i => i.setTitle('从列表移除（不删文件）').setIcon('list-x')
          .onClick(() => this.plugin.unlinkNote(this.period, n.link)));
      } else if (f) {
        menu.addItem(i => i.setTitle('登记到「本期笔记」').setIcon('list-plus')
          .onClick(() => this.plugin.linkNote(this.period, f)));
      }
      if (f) {
        menu.addItem(i => i.setTitle('移到废纸篓').setIcon('trash').onClick(async () => {
          if (n.listed) await this.plugin.unlinkNote(this.period, n.link);
          await this.app.vault.trash(f, true); // 系统废纸篓，可以在访达里恢复
          new Notice(`已把「${n.title}」移到废纸篓`);
        }));
      }
      menu.showAtMouseEvent(e);
    });
    return card;
  }

  buildTips(el) {
    const tip = el.createDiv('pm-tips');
    setIcon(tip.createSpan('pm-tips-icon'), 'lightbulb');
    tip.createSpan({
      text: '拖周期任务卡片可以调整顺序，拖进象限可以拆出今天的子任务；拖任务上下调整顺序，拖到右侧时段排进日程；双击编辑，右键标记进行中 / 已取消，⌘Z 撤销。',
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
    if (t.cancelled) card.addClass('is-cancelled');
    if (t.doing) card.addClass('is-doing');
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
    if (t.doing) tags.push({ cls: 'pm-doing-tag', text: '进行中' });
    if (t.cancelled) tags.push({ cls: 'pm-cancel-tag', text: '已取消' });
    if (parent) tags.push({ cls: 'pm-parent', text: parent.text, level: parent.level });
    if (t.slot) tags.push({ cls: 'pm-slot-tag', text: t.slot.replace('-', '–') });
    if (t.due) {
      const d = countdown(t.due);
      tags.push({ cls: `pm-due ${d.cls}`, text: d.text });
    }
    if (t.age > 0) {
      const o = parseDate(t.origin);
      tags.push({
        cls: 'pm-age ' + (t.age >= 7 ? 'is-hi' : t.age >= 3 ? 'is-mid' : 'is-lo'),
        text: `已拖 ${t.age} 天`,
        title: o ? `最早安排在 ${o.month() + 1}/${o.date()}，之后每天没做完都顺延了下来` : '',
      });
    } else if (this.carried.has(t.raw)) {
      tags.push({ cls: 'pm-carry-tag', text: '顺延' });
    }
    if (t.note) tags.push({ cls: 'pm-note-tag', text: '备注', title: t.note });
    if (tags.length) {
      const row = body.createDiv('pm-tags');
      for (const tg of tags) {
        const s = row.createSpan({ cls: tg.cls, text: tg.text });
        if (tg.title) s.title = tg.title;
        if (tg.level) s.dataset.level = String(tg.level);
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
      this.statusItems(menu, t, upd);
      menu.addSeparator();
      menu.addItem(i => i.setTitle('删除').setIcon('trash').onClick(() => this.remove(scope, t)));
      menu.showAtMouseEvent(e);
    });
    return card;
  }

  // 进行中 [/]、已取消 [-]，以及恢复成未开始
  statusItems(menu, t, upd) {
    if (!t.doing && !t.done) {
      menu.addItem(i => i.setTitle('标记为进行中').setIcon('loader').onClick(() => upd({ doing: true })));
    }
    if (!t.cancelled) {
      menu.addItem(i => i.setTitle('标记为已取消').setIcon('ban')
        .onClick(() => upd({ done: true, cancelled: true, doing: false })));
    }
    if (t.doing || t.done) {
      menu.addItem(i => i.setTitle('恢复为未开始').setIcon('circle')
        .onClick(() => upd({ done: false, cancelled: false, doing: false })));
    }
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
    let overGrid = null;
    let dropBefore = null; // 周期任务排序：放到这张卡片前面；null 表示放到最后
    let dropMark = null;

    const targetAt = ev => {
      const hit = doc.elementFromPoint(ev.clientX, ev.clientY);
      return {
        slot: hit && src.kind === 'day' ? hit.closest('.pm-slot') : null,
        quad: hit ? hit.closest('.pm-quad') : null,
        grid: hit && src.kind === 'period' ? hit.closest('.pm-pgrid') : null,
      };
    };

    // 卡片网格按阅读顺序排：指针在某张卡片上方那一行，或者同一行里在它中线左边，就插到它前面
    const pcards = () => [...this.pgrid.querySelectorAll('.pm-pcard[data-line]')];
    const slotInGrid = ev => {
      for (const c of pcards()) {
        if (c === card) continue;
        const b = c.getBoundingClientRect();
        if (ev.clientY < b.top) return c;
        if (ev.clientY <= b.bottom && ev.clientX < b.left + b.width / 2) return c;
      }
      return null;
    };
    const showGridMark = before => {
      if (dropMark) dropMark.removeClass('is-drop-before', 'is-drop-after');
      dropMark = null;
      if (!overGrid) return;
      const others = pcards().filter(c => c !== card);
      if (before) {
        dropMark = before;
        before.addClass('is-drop-before');
      } else if (others.length) {
        dropMark = others[others.length - 1];
        dropMark.addClass('is-drop-after');
      }
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
      if (dropMark) dropMark.removeClass('is-drop-before', 'is-drop-after');
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
      overGrid = tgt.grid;
      if (src.kind === 'period') {
        dropBefore = overGrid ? slotInGrid(ev) : null;
        showGridMark(dropBefore);
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

    // pointercancel（系统接管了手势）和 Esc 都算取消，不能当成在最后经过的位置放下
    const onUp = async ev => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onUp);
      doc.removeEventListener('keydown', onKey, true);
      if (!moved) return;
      this.justDragged = true;
      window.setTimeout(() => { this.justDragged = false; }, 50);
      const cancelled = ev.type !== 'pointerup';
      const slot = overSlot;
      const quad = overQuad;
      const grid = overGrid;
      const before = dropBefore;
      const all = src.kind === 'period' ? pcards() : [];
      cleanup();
      this.dragging = false;

      if (!cancelled && src.kind === 'period' && grid) {
        // 放回原处（紧挨着自己后面那张，或者本来就是最后一张）就什么都不写
        const next = all[all.indexOf(card) + 1] || null;
        if (before !== next) {
          const bt = before ? this.periodTasks.find(t => String(t.line) === before.dataset.line) : null;
          await this.plugin.movePeriodTask(this.file, src.task, bt);
          return;
        }
      } else if (!cancelled && src.kind === 'period' && quad) {
        this.splitToDay(src.task, +quad.dataset.q);
      } else if (!cancelled && src.kind === 'day' && slot) {
        await this.plugin.updateTask(this.file, this.dayScope(), src.task, { slot: slot.dataset.slot });
        return;
      } else if (!cancelled && src.kind === 'day' && quad) {
        const q = +quad.dataset.q;
        const patches = reorderPatches(this.visibleIn(q), src.task, q, dropIndex);
        if (patches.length) {
          await this.plugin.updateMany(this.file, this.dayScope(), patches);
          return;
        }
      }
      // 没有写文件：拖动期间跳过的刷新请求在这里补一次，免得视图停在旧内容上
      this.requestRefresh();
    };

    const onKey = ev => {
      if (ev.key !== 'Escape' || !moved) return;
      ev.preventDefault();
      ev.stopPropagation();
      onUp(ev);
    };

    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);
    doc.addEventListener('keydown', onKey, true);
  }
}

// ---------- 工作助理（右侧边栏） ----------

const ACTION_ICONS = { add: 'plus', addPeriod: 'flag', done: 'check', doing: 'loader', cancel: 'ban', move: 'move', slot: 'clock' };

class AgentView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.chat = this.newChat();
    this.busy = false;
    this.abort = null;
    this.briefBusy = false;
    this.briefLive = '';
    this.briefOpen = true;
    this.draft = '';
    this.live = null;
    this.paintTimer = 0;
    this.comp = null;
  }

  getViewType() {
    return AGENT_VIEW;
  }

  getDisplayText() {
    return '工作助理';
  }

  getIcon() {
    return 'bot';
  }

  get settings() {
    return this.plugin.settings;
  }

  newChat() {
    return { title: '新对话', created: zoneNow().format('YYYY-MM-DD HH:mm'), messages: [], file: null };
  }

  async onOpen() {
    this.contentEl.addClass('pm-agent');
    this.registerEvent(this.app.workspace.on('css-change', () => this.render()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.fitStatusBar()));
    this.registerEvent(this.app.workspace.on('resize', () => this.fitStatusBar()));
    this.registerDomEvent(window, 'resize', () => this.fitStatusBar());
    this.registerDomEvent(this.contentEl, 'click', e => {
      const a = e.target.closest && e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      if (a.hasClass('internal-link')) this.app.workspace.openLinkText(a.getAttr('data-href') || a.getAttr('href'), '', 'tab');
      else if (a.href) window.open(a.href);
    });
    this.render();
  }

  async onClose() {
    if (this.abort) this.abort.abort();
    window.clearTimeout(this.paintTimer);
  }

  linkPath() {
    const p = this.plugin.periodFor(zoneNow());
    return p ? p.file.path : '';
  }

  render() {
    const el = this.contentEl;
    el.empty();
    applySkin(el, this.plugin);
    el.removeClass('pm-space');
    if (this.comp) this.removeChild(this.comp);
    this.comp = this.addChild(new Component());
    this.live = null;
    this.buildBar(el);
    this.listEl = el.createDiv('pm-ag-list');
    this.renderList();
    this.buildComposer(el);
    window.requestAnimationFrame(() => this.fitStatusBar());
  }

  // Obsidian 的状态栏浮在窗口右下角，会盖住输入框：重叠多少，输入区底部就多留多少
  fitStatusBar() {
    const box = this.composerEl;
    if (!box || !box.isConnected) return;
    const sb = document.body.querySelector('.status-bar');
    let pad = 0;
    if (sb && sb.offsetParent !== null) {
      const a = sb.getBoundingClientRect();
      const b = this.contentEl.getBoundingClientRect();
      if (a.height && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) pad = Math.ceil(b.bottom - a.top) + 6;
    }
    box.style.paddingBottom = pad ? `calc(0.75em + ${pad}px)` : '';
  }

  // ----- 顶栏：模型、推理强度、历史、新对话 -----

  buildBar(el) {
    const bar = el.createDiv('pm-ag-bar');
    const sel = bar.createEl('select', { cls: 'pm-select is-small pm-ag-model' });
    for (const m of AGENT_MODELS) sel.createEl('option', { value: m.id, text: m.label });
    if (!AGENT_MODELS.some(m => m.id === this.settings.agentModel)) {
      sel.createEl('option', { value: this.settings.agentModel, text: this.settings.agentModel });
    }
    sel.value = this.settings.agentModel;
    sel.onchange = async () => {
      this.settings.agentModel = sel.value;
      await this.plugin.saveData(this.settings);
    };
    const seg = bar.createDiv({ cls: 'pm-seg pm-ag-effort', attr: { role: 'group', 'aria-label': '推理强度' } });
    for (const [k, label] of EFFORTS) {
      const b = seg.createEl('button', { cls: 'pm-zone-btn' + (this.settings.agentEffort === k ? ' is-on' : ''), text: label });
      b.title = `推理强度：${label}。越高想得越久，也更贵`;
      b.onclick = async () => {
        this.settings.agentEffort = k;
        seg.querySelectorAll('button').forEach(x => x.toggleClass('is-on', x === b));
        await this.plugin.saveData(this.settings);
      };
    }
    bar.createDiv('pm-spacer');
    iconBtn(bar, 'history', '历史对话').onclick = e => this.historyMenu(e);
    iconBtn(bar, 'square-pen', '新对话').onclick = () => {
      if (this.busy) return;
      this.chat = this.newChat();
      this.render();
    };
  }

  historyMenu(e) {
    const menu = new Menu();
    const files = this.plugin.listChats().slice(0, 20);
    if (!files.length) menu.addItem(i => i.setTitle('还没有保存的对话').setDisabled(true));
    for (const f of files) {
      menu.addItem(i => i.setTitle(f.basename).setIcon('message-square').setChecked(!!this.chat.file && this.chat.file.path === f.path)
        .onClick(() => this.load(f)));
    }
    if (this.chat.file) {
      menu.addSeparator();
      menu.addItem(i => i.setTitle('打开当前对话的笔记').setIcon('file-text')
        .onClick(() => this.app.workspace.getLeaf('tab').openFile(this.chat.file)));
    }
    menu.showAtMouseEvent(e);
  }

  async load(f) {
    if (this.busy) return;
    const c = parseChat(await this.app.vault.read(f));
    this.chat = Object.assign(c, { file: f });
    if (!this.chat.created) this.chat.created = moment(f.stat.ctime).format('YYYY-MM-DD HH:mm');
    this.render();
  }

  async save() {
    if (!this.chat.messages.length) return;
    try {
      await this.plugin.saveChat(this.chat);
    } catch (e) {
      console.error('[workmap] 保存对话失败', e);
    }
  }

  // ----- 简报和消息列表 -----

  renderList() {
    const list = this.listEl;
    list.empty();
    this.buildBrief(list);
    if (!this.chat.messages.length) this.buildWelcome(list);
    this.chat.messages.forEach(m => list.appendChild(this.bubble(m)));
    window.setTimeout(() => { list.scrollTop = list.scrollHeight; }, 0);
  }

  buildBrief(parent) {
    const today = zoneNow().format('YYYY-MM-DD');
    const b = this.settings.brief && this.settings.brief.date === today ? this.settings.brief : null;
    const card = parent.createDiv('pm-ag-brief');
    const head = card.createDiv('pm-ag-brief-head');
    setIcon(head.createSpan('pm-ag-brief-icon'), 'sun');
    head.createSpan({ cls: 'pm-ag-brief-title', text: '今日简报' });
    if (b && !this.briefBusy) head.createSpan({ cls: 'pm-ag-meta', text: `${b.at} · ${agentModel(b.model).label}` });
    head.createDiv('pm-spacer');
    if (b && !this.briefBusy) {
      iconBtn(head, this.briefOpen ? 'chevron-up' : 'chevron-down', this.briefOpen ? '收起' : '展开').onclick = () => {
        this.briefOpen = !this.briefOpen;
        this.renderList();
      };
    }
    const btn = textBtn(head, this.briefBusy ? '生成中…' : b ? '刷新' : '生成', 'is-ghost', 'sparkles');
    btn.disabled = this.briefBusy || this.busy;
    btn.onclick = () => this.makeBrief();
    const body = card.createDiv('pm-ag-brief-body pm-text');
    this.briefBody = body;
    if (this.briefBusy) {
      if (this.briefLive) renderMd(this.app, this.briefLive, body, this.linkPath(), this.comp);
      else body.createDiv({ cls: 'pm-ag-hint is-wait', text: '正在读今天、昨天的任务和本期笔记…' });
    } else if (b) {
      if (this.briefOpen) renderMd(this.app, b.text, body, this.linkPath(), this.comp);
      else card.addClass('is-folded');
    } else {
      body.createDiv({ cls: 'pm-ag-hint', text: '点「生成」，总结今天和昨天的任务、主线进展和最近的笔记，并给出今天先做的一件事。' });
    }
  }

  async makeBrief() {
    if (this.briefBusy || this.busy) return;
    const model = this.settings.agentModel;
    this.briefBusy = true;
    this.briefLive = '';
    this.briefOpen = true;
    this.renderList();
    try {
      const context = await this.plugin.agentContextFor({ today: true, yesterday: true, period: true, notes: true });
      const r = await this.plugin.streamChat({
        model,
        effort: this.settings.agentEffort,
        system: agentSystem(this.settings.slots, context),
        messages: [{ role: 'user', content: AGENT_BRIEF_PROMPT }],
        onDelta: acc => {
          this.briefLive = visibleReply(acc.text);
          this.paint(() => {
            this.briefBody.empty();
            return renderMd(this.app, this.briefLive, this.briefBody, this.linkPath(), this.comp);
          });
        },
      });
      this.settings.brief = { date: zoneNow().format('YYYY-MM-DD'), at: zoneNow().format('HH:mm'), model, text: parseActions(r.text).text, usage: r.usage };
      await this.plugin.saveData(this.settings);
    } catch (e) {
      new Notice(`简报生成失败：${e.message || e}`, 10000);
    } finally {
      this.briefBusy = false;
      this.render();
    }
  }

  buildWelcome(parent) {
    const w = parent.createDiv('pm-ag-welcome');
    w.createDiv({ cls: 'pm-ag-welcome-title', text: '有什么要我帮忙的？' });
    w.createDiv({
      cls: 'pm-ag-hint',
      text: '我能看到下面勾选的内容（今天、昨天的任务，本期主线和笔记），每次提问都会重新读一遍笔记。需要改任务时我会给出建议，你点「确认」才会写进笔记。',
    });
  }

  bubble(m) {
    const el = createDiv({ cls: `pm-ag-msg is-${m.role}` });
    if (m.role === 'user') {
      el.createDiv({ cls: 'pm-ag-user', text: m.content });
      return el;
    }
    const think = el.createEl('details', { cls: 'pm-ag-think' });
    const sum = think.createEl('summary', { text: m.pending && !m.content ? '思考中…' : '思考过程' });
    const thinkBody = think.createDiv({ cls: 'pm-ag-think-body', text: m.thinking || '' });
    if (!m.thinking) think.hide();
    const body = el.createDiv('pm-ag-body pm-text');
    if (m.pending) {
      if (m.content) renderMd(this.app, visibleReply(m.content), body, this.linkPath(), this.comp);
      else body.createDiv({ cls: 'pm-ag-dots' }).createSpan({ text: '···' });
      this.live = { body, think, sum, thinkBody };
      return el;
    }
    renderMd(this.app, m.content || '', body, this.linkPath(), this.comp);
    this.buildActions(el, m);
    const meta = el.createDiv('pm-ag-meta');
    const u = m.usage;
    meta.setText([m.model, m.time, u && u.output != null ? `${u.input || 0} → ${u.output} tokens` : '', u && u.cost ? u.cost : ''].filter(Boolean).join(' · '));
    const copy = meta.createSpan({ cls: 'pm-ag-copy', text: '复制' });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(m.content || '');
      copy.setText('已复制');
    };
    return el;
  }

  // 流式输出时最多 100ms 重画一次
  paint(fn) {
    if (this.paintTimer) return;
    this.paintTimer = window.setTimeout(async () => {
      this.paintTimer = 0;
      const list = this.listEl;
      const atBottom = list && list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      await fn();
      if (list && atBottom) list.scrollTop = list.scrollHeight;
    }, 100);
  }

  paintLive(m) {
    this.paint(() => {
      const live = this.live;
      if (!live) return null;
      if (m.thinking) {
        live.think.show();
        live.thinkBody.setText(m.thinking);
        live.sum.setText(m.content ? '思考过程' : '思考中…');
      }
      if (!m.content) return null;
      live.body.empty();
      return renderMd(this.app, visibleReply(m.content), live.body, this.linkPath(), this.comp);
    });
  }

  // ----- 建议的改动 -----

  buildActions(el, m) {
    if (!m.actions || !m.actions.length) return;
    const box = el.createDiv('pm-ag-actions');
    const head = box.createDiv('pm-ag-actions-head');
    head.createSpan({ text: `建议的改动 · ${m.actions.length} 项` });
    head.createDiv('pm-spacer');
    const pending = m.actions.filter(a => !a.state || a.state === 'error');
    if (pending.length > 1) textBtn(head, '全部确认', 'is-primary').onclick = () => this.runActions(m, pending);
    for (const a of m.actions) {
      const row = box.createDiv('pm-ag-act' + (a.state ? ` is-${a.state}` : ''));
      setIcon(row.createSpan('pm-ag-act-icon'), ACTION_ICONS[a.op] || 'dot');
      const txt = row.createDiv('pm-ag-act-text');
      txt.createSpan({ text: describeAction(a) });
      if (a.state === 'error') txt.createDiv({ cls: 'pm-ag-act-err', text: a.error || '失败' });
      if (a.state === 'done') row.createSpan({ cls: 'pm-ag-act-state', text: '已执行' });
      else if (a.state === 'skip') row.createSpan({ cls: 'pm-ag-act-state', text: '已忽略' });
      else {
        iconBtn(row, 'check', '确认', 'pm-ag-ok').onclick = () => this.runActions(m, [a]);
        iconBtn(row, 'x', '忽略').onclick = async () => {
          a.state = 'skip';
          await this.save();
          this.renderList();
        };
      }
    }
  }

  async runActions(m, list) {
    let ok = 0;
    for (const a of list) {
      try {
        await this.plugin.applyAction(a);
        a.state = 'done';
        delete a.error;
        ok++;
      } catch (e) {
        a.state = 'error';
        a.error = e.message || String(e);
      }
    }
    await this.save();
    this.renderList();
    if (ok) new Notice(`已执行 ${ok} 项改动。在 Workmap 里按 ⌘Z 可以逐项撤销`);
  }

  // ----- 输入区 -----

  buildComposer(el) {
    const box = el.createDiv('pm-ag-composer');
    this.composerEl = box;
    let ta = null;
    const chips = box.createDiv('pm-ag-quick');
    for (const [label, text] of AGENT_QUICK) {
      const c = chips.createEl('button', { cls: 'pm-ag-chip', text: label });
      c.disabled = this.busy;
      c.onclick = () => {
        const hole = text.indexOf('「」');
        if (hole < 0) {
          this.send(text);
          return;
        }
        ta.value = text;
        this.draft = text;
        ta.focus();
        ta.setSelectionRange(hole + 1, hole + 1);
        fit();
      };
    }
    const ctx = box.createDiv('pm-ag-ctx');
    ctx.createSpan({ cls: 'pm-ag-ctx-label', text: '带上' });
    const flags = this.settings.agentCtx;
    for (const [k, label] of AGENT_CTX) {
      const b = ctx.createEl('button', { cls: 'pm-ag-ctxbtn' + (flags[k] ? ' is-on' : ''), text: label });
      b.onclick = async () => {
        flags[k] = !flags[k];
        b.toggleClass('is-on', flags[k]);
        await this.plugin.saveData(this.settings);
      };
    }
    const row = box.createDiv('pm-ag-inputrow');
    ta = row.createEl('textarea', { cls: 'pm-ag-input', attr: { rows: '1', placeholder: '问点什么，或者让我帮你安排今天…（Shift+回车换行）' } });
    ta.value = this.draft;
    const fit = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    };
    ta.oninput = () => {
      this.draft = ta.value;
      fit();
    };
    ta.addEventListener('keydown', e => {
      if (isSubmitKey(e) && !e.shiftKey) {
        e.preventDefault();
        this.send(ta.value);
      }
    });
    const btn = iconBtn(row, this.busy ? 'square' : 'arrow-up', this.busy ? '停止' : '发送', 'pm-ag-send' + (this.busy ? ' is-stop' : ''));
    btn.onclick = () => (this.busy ? this.abort && this.abort.abort() : this.send(ta.value));
    window.setTimeout(fit, 0);
    this.inputEl = ta;
  }

  async send(raw) {
    const text = (raw || '').trim();
    if (!text || this.busy || this.briefBusy) return;
    if (!this.settings.aiKey) {
      new Notice('先在设置 → Workmap → 大模型里填写 API 密钥');
      return;
    }
    const model = this.settings.agentModel;
    const now = zoneNow();
    if (!this.chat.messages.length) {
      this.chat.title = chatTitle(text);
      this.chat.created = now.format('YYYY-MM-DD HH:mm');
    }
    this.chat.messages.push({ role: 'user', content: text, time: now.format('HH:mm') });
    const reply = { role: 'assistant', content: '', thinking: '', model: agentModel(model).label, time: now.format('HH:mm'), actions: [], pending: true };
    this.chat.messages.push(reply);
    this.draft = '';
    this.busy = true;
    this.abort = new AbortController();
    this.render();
    try {
      const context = await this.plugin.agentContextFor(this.settings.agentCtx);
      // 历史消息：只带正文；建议过的改动用一句话带上，模型才知道之前说过什么
      const history = this.chat.messages
        .filter(m => m !== reply && (m.content || '').trim())
        .slice(-20)
        .map(m => ({
          role: m.role,
          content: m.role === 'assistant' && m.actions && m.actions.length
            ? `${m.content}\n\n（我建议过：${m.actions.map(a => describeAction(a) + (a.state === 'done' ? '，已执行' : a.state === 'skip' ? '，被忽略' : '')).join('；')}）`
            : m.content,
        }));
      const r = await this.plugin.streamChat({
        model,
        effort: this.settings.agentEffort,
        system: agentSystem(this.settings.slots, context),
        messages: history,
        signal: this.abort.signal,
        onDelta: acc => {
          reply.content = acc.text;
          reply.thinking = acc.thinking;
          this.paintLive(reply);
        },
      });
      const parsed = parseActions(r.text);
      reply.content = parsed.text;
      reply.actions = parsed.actions;
      reply.thinking = r.thinking;
      reply.usage = r.usage;
    } catch (e) {
      const sofar = visibleReply(reply.content);
      reply.content = e.name === 'AbortError'
        ? `${sofar}\n\n*（已停止）*`.trim()
        : `${sofar ? sofar + '\n\n' : ''}> [!error] 请求失败\n> ${e.message || e}`;
    } finally {
      delete reply.pending;
      this.busy = false;
      this.abort = null;
      window.clearTimeout(this.paintTimer);
      this.paintTimer = 0;
      await this.save();
      this.render();
    }
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
    const ok = textBtn(f, okText, 'is-primary');
    ok.onclick = onOk;
    return ok;
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
      if (isSubmitKey(e) && !e.metaKey && !e.ctrlKey) this.save();
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
      if (isSubmitKey(e)) this.submit(input.value);
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
      if (isSubmitKey(e)) this.submit(input.value);
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

class NameModal extends SkinModal {
  constructor(plugin, title, sub, onSubmit) {
    super(plugin);
    this.title = title;
    this.sub = sub;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.skin(this.title, this.sub);
    const input = this.field('标题').createEl('input', { type: 'text', cls: 'pm-input is-lg' });
    input.placeholder = '例如：控制回路与串级控制';
    input.addEventListener('keydown', e => {
      if (isSubmitKey(e)) this.submit(input.value);
    });
    window.setTimeout(() => input.focus(), 0);
    this.footer('创建', () => this.submit(input.value));
  }

  submit(v) {
    const text = v.trim();
    if (!text) return;
    this.close();
    this.onSubmit(text);
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
    // 日期有问题（跨月、结束早于开始、和已有的期重叠）时直接在预览里说明，不用等点了「创建」才提示
    const updatePreview = () => {
      const s = moment(this.start, 'YYYY-MM-DD', true);
      const e = moment(this.end, 'YYYY-MM-DD', true);
      const problem = periodProblem(s, e, this.plugin.periods());
      preview.toggleClass('is-warn', !!problem);
      preview.setText(problem
        || `将创建 ${s.year()}/${pad(s.month() + 1)}/${s.date()}-${e.date()}.md，共 ${e.diff(s, 'days') + 1} 天`);
      if (this.okBtn) this.okBtn.disabled = !!problem;
    };
    const endQuick = () => {
      const s = moment(this.start, 'YYYY-MM-DD');
      return [10, 20, s.daysInMonth()]
        .filter(d => d >= s.date())
        .map(d => [d === s.daysInMonth() ? '月末' : `${d} 日`, s.clone().date(d)]);
    };

    buildDatePicker(this.field('开始日期'), {
      value: this.start,
      quick: [['今天', zoneNow().startOf('day')]],
      clearable: false,
      noCountdown: true,
      onChange: v => {
        if (!v) return;
        this.start = v;
        this.end = periodEndFor(moment(v, 'YYYY-MM-DD'), this.plugin.periods()).format('YYYY-MM-DD');
        drawEnd();
        updatePreview();
        if (this.updateMigNote) this.updateMigNote();
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
    const migNote = mig.createDiv({ cls: 'pm-modal-note' });
    this.updateMigNote = () => {
      const s = moment(this.start, 'YYYY-MM-DD', true);
      const src = s.isValid() ? this.plugin.migrationSource(s) : null;
      migNote.setText(this.plugin.migrationDeferred(src, zoneNow().startOf('day'))
        ? `${src.label} 还没结束，现在不会动它；到 ${s.month() + 1}/${s.date()} 新一期开始时，再把那时没完成的周期任务移过来。没做完的每日任务会自动顺延。`
        : '没做完的每日任务不用迁移，会在当天自动顺延。');
    };
    this.updateMigNote();

    this.contentEl.appendChild(preview);
    this.okBtn = this.footer('创建', () => this.create());
    updatePreview();
  }

  async create() {
    if (this.creating) return;
    const s = moment(this.start, 'YYYY-MM-DD', true);
    const e = moment(this.end, 'YYYY-MM-DD', true);
    if (!s.isValid() || !e.isValid()) {
      new Notice('日期格式不对');
      return;
    }
    // 连点两次「创建」不能建出两份（第二次会因为文件已存在而报错）
    this.creating = true;
    let file = null;
    try {
      file = await this.plugin.createPeriod(s, e, this.migrate);
    } finally {
      this.creating = false;
    }
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
      .setName('美国时区')
      .setDesc('顶部选「美国」时用哪个时区。香港和巴黎在顶部直接切换。')
      .addDropdown(dd => {
        for (const [tz, , label] of US_ZONES) dd.addOption(tz, label);
        dd.setValue(s.usZone).onChange(v => this.plugin.setZone(s.zone, v));
      });
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
      .setName('顺延起点')
      .setDesc('早于这一天的任务不再自动顺延，格式 YYYY-MM-DD。留空则只顺延上一期和本期的任务。')
      .addText(tc => tc.setPlaceholder('例如 2026-11-18').setValue(s.carryStart || '').onChange(async v => {
        v = v.trim();
        if (v && !parseDate(v)) return;
        s.carryStart = v;
        await this.plugin.saveData(s);
      }));
    new Setting(containerEl)
      .setName('顺延后的原任务')
      .setDesc('没做完的任务每天会自动顺延到今天。原来那天的那一行保留为 [>]（能看到每天的记录），还是直接删掉（笔记更干净）。两种方式都会记下最初安排的日期，用来显示「已拖 N 天」。')
      .addDropdown(dd => dd
        .addOption('mark', '保留，标成 [>]')
        .addOption('move', '删掉')
        .setValue(s.carryMode === 'move' ? 'move' : 'mark')
        .onChange(async v => {
          s.carryMode = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('日程时段')
      .setDesc('格式如 07-09，用英文逗号分隔')
      .addText(tc => tc.setValue(s.slots.join(',')).onChange(async v => {
        s.slots = v.split(',').map(x => x.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName('大模型（AI 回顾 / 出题）').setHeading();
    containerEl.createDiv({
      cls: 'setting-item-description',
      text: '通过 DMXAPI 调用模型。点「AI 回顾」或「AI 出题」时，本期的任务和笔记内容会发送给 DMXAPI 和所选模型的提供方；密钥只存在本机的插件设置（data.json）里。',
    });
    new Setting(containerEl)
      .setName('API 密钥')
      .setDesc('在 DMXAPI 控制台「API 令牌」里创建，形如 sk-…')
      .addText(tc => {
        tc.inputEl.type = 'password';
        tc.setPlaceholder('sk-…').setValue(s.aiKey || '').onChange(async v => {
          s.aiKey = v.trim();
          await this.plugin.saveData(s);
        });
      });
    const preset = AI_MODELS.some(m => m[0] === s.aiModel);
    new Setting(containerEl)
      .setName('模型')
      .setDesc('回顾和出题用哪个模型。选「其他」可以填 DMXAPI 上的任意模型名')
      .addDropdown(dd => {
        for (const [id, label] of AI_MODELS) dd.addOption(id, label);
        dd.addOption('__custom', '其他…');
        dd.setValue(preset ? s.aiModel : '__custom').onChange(async v => {
          if (v !== '__custom') s.aiModel = v;
          await this.plugin.saveData(s);
          this.display();
        });
      });
    if (!preset) {
      new Setting(containerEl)
        .setName('模型名')
        .addText(tc => tc.setPlaceholder('例如 qwen3.8-max').setValue(s.aiModel || '').onChange(async v => {
          s.aiModel = v.trim();
          await this.plugin.saveData(s);
        }));
    }
    new Setting(containerEl)
      .setName('接口地址')
      .setDesc('一般不用改')
      .addText(tc => tc.setPlaceholder(DEFAULT_SETTINGS.aiBase).setValue(s.aiBase || '').onChange(async v => {
        s.aiBase = v.trim() || DEFAULT_SETTINGS.aiBase;
        await this.plugin.saveData(s);
      }))
      .addButton(b => b.setButtonText('测试连接').onClick(async () => {
        b.setDisabled(true);
        b.setButtonText('测试中…');
        try {
          const r = await this.plugin.chat('只回复「连接正常」四个字。', 'ping');
          new Notice(`${r.model}：${r.text}`);
        } catch (e) {
          new Notice(`连接失败：${e.message || e}`, 10000);
        } finally {
          b.setDisabled(false);
          b.setButtonText('测试连接');
        }
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
  moveTaskBlock,
  openPeriodBlocks,
  insertPeriodBlocks,
  removePeriodBlocks,
  quadOf,
  quadList,
  spreadY,
  endPos,
  reorderPatches,
  heatOf,
  longestRun,
  periodStats,
  hashStr,
  rng,
  skyLayout,
  dustLayout,
  galaxyAt,
  galaxyWidth,
  galaxyLayout,
  renderGalaxy,
  parsePeriod,
  defaultEnd,
  splitLines,
  countChildren,
  readNote,
  noteLines,
  collectCarry,
  markCarried,
  unmarkCarried,
  chainOrigin,
  carryAge,
  notesRange,
  listNoteLinks,
  ensureNotesSection,
  noteLinkLine,
  addNoteLink,
  strayBlocks,
  strayTitle,
  safeFileName,
  takeStray,
  periodDigest,
  dayDigest,
  agentModel,
  buildChatRequest,
  sseSplit,
  streamDelta,
  replyOf,
  parseActions,
  visibleReply,
  describeAction,
  matchTask,
  formatChat,
  parseChat,
  chatTitle,
  agentContext,
  agentSystem,
  httpErrorText,
  isSubmitKey,
  periodProblem,
  suggestPeriod,
  periodEndFor,
  fillTemplate,
  daysUntil,
  countdown,
  zoneParts,
  momentIn,
  zoneTz,
  guessZone,
  utcOffsetLabel,
};
