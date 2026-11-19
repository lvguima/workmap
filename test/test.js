const Module = require('module');
const moment = require('moment');
const origLoad = Module._load;
class Dummy {}
Module._load = function (req, ...rest) {
  if (req === 'obsidian') {
    return new Proxy({ moment }, { get: (t, k) => (k in t ? t[k] : Dummy) });
  }
  if (req === '@codemirror/view') throw new Error('no cm');
  return origLoad.call(this, req, ...rest);
};
const assert = require('assert');
const T = require('../main.js')._test;

const lines = [
  '[🧭 打开四象限](obsidian://matrix)',
  '',
  '## 周期任务',
  '',
  '- [x] 项目申报：启明星 ★★★ 📅 2026-11-25 %%id:pabc%%',
  '- [ ] 论文：jf',
  '  - 子项',
  '',
  '---',
  '',
  '## 18',
  '',
  '习惯：✅REVIEW ⬜workoUT',
  '',
  '- [ ] 写第三部分 %%p:pabc%% %%t:09-11%% %%m:70,20%%',
  '一些笔记',
  '',
  '## 17',
  '- [ ] 旧任务',
];
const pr = T.periodRange(lines);
assert.deepStrictEqual(pr, { start: 2, end: 8 });
const pts = T.collectTasks(lines, pr, 'period');
assert.strictEqual(pts.length, 2);
assert.strictEqual(pts[0].level, 3);
assert.strictEqual(pts[1].note, '- 子项');
assert.strictEqual(pts[0].due, '2026-11-25');
assert.strictEqual(pts[0].id, 'pabc');
assert.strictEqual(pts[1].children, 1);
assert.strictEqual(T.formatTask(pts[0]), lines[4]);

const days = T.listDays(lines);
assert.deepStrictEqual(days.map(d => [d.day, d.start, d.end]), [[18, 10, 17], [17, 17, 19]]);
const dt = T.collectTasks(lines, days[0], 'day');
assert.strictEqual(dt.length, 1);
const t = dt[0];
assert.strictEqual(t.parent, 'pabc');
assert.strictEqual(t.slot, '09-11');
assert.deepStrictEqual([t.x, t.y], [70, 20]);
assert.strictEqual(T.quadOf(t), 1);
assert.strictEqual(T.parseTaskLine(T.formatTask(t), 0).text, '写第三部分');
assert.strictEqual(T.formatTask(t), '- [ ] 写第三部分 %%p:pabc%% %%t:09-11%% %%m:70,20%%');

assert.deepStrictEqual([...T.parseHabits(lines[12])], ['REVIEW']);

// ensureDay: insert 19 above 18
const l2 = lines.slice();
const r19 = T.ensureDay(l2, 19);
assert.strictEqual(l2[r19.start], '## 19');
assert.ok(r19.start < T.dayRange(l2, 18).start);
T.insertTaskBlock(l2, r19, ['- [ ] 新']);
const r19b = T.dayRange(l2, 19);
assert.ok(l2.slice(r19b.start, r19b.end).includes('- [ ] 新'));
// insert into 18 after last task
T.insertTaskBlock(l2, T.dayRange(l2, 18), ['- [ ] 第二']);
const r18 = T.dayRange(l2, 18);
const seg = l2.slice(r18.start, r18.end);
assert.strictEqual(seg[seg.indexOf('- [ ] 写第三部分 %%p:pabc%% %%t:09-11%% %%m:70,20%%') + 1], '- [ ] 第二');

// ensureDay into file with no days, older day 16 in file only lower days
const l3 = ['## 周期任务', '', '- [ ] a', ''];
const r = T.ensureDay(l3, 18);
assert.deepStrictEqual(l3, ['## 周期任务', '', '- [ ] a', '', '---', '', '## 18', '']);
T.insertTaskBlock(l3, r, ['- [ ] x']);
console.log(l3);
// replace empty task
const l4 = ['## 18', '', '- [ ] ', ''];
T.insertTaskBlock(l4, T.dayRange(l4, 18), ['- [ ] y']);
assert.deepStrictEqual(l4, ['## 18', '', '- [ ] y', '']);
// habit-only day
const l5 = ['## 18', '', '习惯：✅REVIEW', ''];
T.insertTaskBlock(l5, T.dayRange(l5, 18), ['- [ ] z']);
console.log(l5);

const p = T.parsePeriod({ path: '2026/11/18-30.md' });
assert.strictEqual(p.startDate.format('YYYY-MM-DD'), '2026-11-18');
assert.strictEqual(p.endDate.format('YYYY-MM-DD'), '2026-11-30');
assert.strictEqual(T.parsePeriod({ path: '2026/11/x.md' }), null);
const de = s => T.defaultEnd(moment(s)).format('YYYY-MM-DD');
assert.strictEqual(de('2026-12-01'), '2026-12-10');
assert.strictEqual(de('2026-12-06'), '2026-12-20');
assert.strictEqual(de('2026-12-11'), '2026-12-20');
assert.strictEqual(de('2026-12-16'), '2026-12-31');
assert.strictEqual(de('2026-12-28'), '2026-12-31');
// old legacy heading
assert.ok(T.periodRange(['## 四象限', '- [ ] a']));
// CRLF
assert.strictEqual(T.splitLines('a\r\nb').eol, '\r\n');

// legacy bold -> level 3
const lg = T.parseTaskLine('- [ ] **TIM_response** 📅 2026-12-02 %%id:pfubl%%', 0);
assert.strictEqual(lg.level, 3); assert.strictEqual(lg.text, 'TIM_response');
assert.strictEqual(T.formatTask(lg), '- [ ] TIM_response ★★★ 📅 2026-12-02 %%id:pfubl%%');
const l1 = T.parseTaskLine('- [ ] 调研 ★ %%id:pq%%', 0);
assert.strictEqual(l1.level, 1); assert.strictEqual(l1.text, '调研');
// notes
assert.deepStrictEqual(T.noteLines('第一行\n\n- [ ] 子步骤 '), ['  第一行', '  - [ ] 子步骤']);
const nl = ['## 周期任务', '- [ ] a', '    深缩进', '    - x', '- [ ] b'];
const ct = T.collectTasks(nl, T.periodRange(nl), 'period');
assert.strictEqual(ct[0].note, '深缩进\n- x');
assert.strictEqual(ct[1].note, '');
// habits with spaces/emoji
const hs = T.parseHabits('习惯：✅🏃 健身 30 分钟 ⬜📖 阅读 ✅REVIEW');
assert.deepStrictEqual([...hs], ['🏃 健身 30 分钟', 'REVIEW']);
assert.strictEqual(T.formatHabits(['🏃 健身 30 分钟', '📖 阅读'], hs), '习惯：✅🏃 健身 30 分钟 ⬜📖 阅读');
// list mode
assert.deepStrictEqual(T.spreadY(1, 1), [25]);
assert.deepStrictEqual(T.spreadY(2, 3), [68, 82]);
const mk = (line, x, y, done = false) => ({ line, x, y, done, raw: 'r' + line });
const qt = [mk(1, 80, 30), mk(2, 70, 10), mk(3, 20, 20), mk(4, 80, 5, true), mk(5, null, null)];
assert.deepStrictEqual(T.quadList(qt, 1).map(t => t.line), [2, 1, 4]);
assert.deepStrictEqual(T.endPos(qt, 1), { x: 75, y: 32 });
assert.deepStrictEqual(T.endPos(qt, 4), { x: 75, y: 75 });
assert.deepStrictEqual(T.endPos([mk(1, 80, 46)], 1), { x: 75, y: 46 });
// move line 1 to the top of q1
const q1 = T.quadList(qt, 1);
let ps = T.reorderPatches(q1, qt[0], 1, 0);
const after = q1.map(t => Object.assign({}, t, (ps.find(p => p.task === t) || {}).patch));
assert.deepStrictEqual(after.sort((a, b) => a.y - b.y).map(t => t.line), [1, 2, 4]);
// drop task from q2 into q1 middle -> x changes to 75
ps = T.reorderPatches(q1, qt[2], 1, 1);
const moved = ps.find(p => p.task === qt[2]).patch;
assert.strictEqual(moved.x, 75);
assert.strictEqual(T.quadOf(moved), 1);
// unplaced task into empty q3
ps = T.reorderPatches([], qt[4], 3, 0);
assert.deepStrictEqual(ps[0].patch, { x: 25, y: 75 });
assert.strictEqual(T.quadOf(ps[0].patch), 3);
// no-op reorder produces no patches once evenly spaced
const even = [mk(1, 75, 18), mk(2, 75, 32)];
assert.deepStrictEqual(T.reorderPatches(even, even[0], 1, 0), []);
// habit streak
const hb = new Map([[18, new Set(['a'])], [19, new Set(['a', 'b'])], [20, new Set(['b'])]]);
assert.strictEqual(T.habitStreak(hb, 'a', 19, 18), 2);
assert.strictEqual(T.habitStreak(hb, 'a', 20, 18), 2); // today not yet done -> count up to yesterday
assert.strictEqual(T.habitStreak(hb, 'b', 20, 18), 2);
assert.strictEqual(T.habitStreak(hb, 'a', 21, 18), 0);
assert.strictEqual(T.habitStreak(hb, 'a', 19, 19), 1);
// fx: heat
const today = require('moment')().format('YYYY-MM-DD');
const ht = [mk(1, 80, 30), mk(2, 70, 10), mk(3, 20, 20), mk(4, 80, 5, true)];
assert.deepStrictEqual(T.heatOf([], []), { level: 0, n: 0, soon: false });
assert.strictEqual(T.heatOf(ht, []).level, 1);
assert.strictEqual(T.heatOf(ht, []).n, 2);
assert.strictEqual(T.heatOf([...ht, mk(5, 90, 40), mk(6, 90, 41), mk(7, 90, 42)], []).level, 3);
// due today on parent bumps heat
const hp = Object.assign(mk(8, 80, 20), { parent: 'pA' });
const r1 = T.heatOf([hp], [{ id: 'pA', due: today }]);
assert.strictEqual(r1.soon, true);
assert.strictEqual(r1.level, 2);
assert.strictEqual(T.heatOf([hp], [{ id: 'pA', due: '2099-01-01' }]).level, 1);
// fx: stats
assert.strictEqual(T.longestStreak(hb, 'a', 18, 21), 2);
assert.strictEqual(T.longestStreak(hb, 'b', 18, 21), 2);
assert.strictEqual(T.longestStreak(hb, 'c', 18, 21), 0);
const st = T.periodStats({
  periodTasks: [{ done: true }, { done: true }],
  allDaily: [{ done: true }, { done: false }, { done: true }],
  habitByDay: hb,
  habits: ['a', 'b'],
  start: 18,
  end: 30,
  day: 20,
});
assert.deepStrictEqual(st, {
  periodDone: 2, periodTotal: 2, dailyDone: 2, dailyTotal: 3,
  checkins: 4, best: { name: 'a', n: 2 }, nth: 3, total: 13,
});
// sky
assert.strictEqual(T.hashStr('abc'), T.hashStr('abc'));
assert.notStrictEqual(T.hashStr('abc'), T.hashStr('abd'));
const ra = T.rng(42); const rb = T.rng(42);
for (let i = 0; i < 5; i++) { const v = ra(); assert.strictEqual(v, rb()); assert.ok(v >= 0 && v < 1); }
const sd = (line, day, text, x, y, done, parent) => ({ line, day, text, x, y, done, parent, raw: `r${line}` });
const spt = [{ id: 'pA', level: 3, text: '论文' }, { id: 'pB', level: 1, text: '调研' }];
const sk = [
  sd(1, 18, 'a', 75, 20, true, 'pA'),
  sd(2, 18, 'b', 75, 30, true, 'pA'),
  sd(3, 19, 'c', 25, 20, true, 'pB'),
  sd(4, 19, 'a', 75, 25, true, 'pA'),
  sd(5, 19, 'd', 75, 80, false),
  sd(6, 20, 'e', 75, 20, true),
  sd(7, 19, 'f', null, null, true),
];
const L1 = T.skyLayout(sk, spt, 19);
assert.strictEqual(L1.stars.length, 4); // 未完成、没放象限、晚于查看日的不算
assert.deepStrictEqual(L1.stars.map(s => s.q), [1, 1, 2, 1]);
assert.strictEqual(L1.stars[0].level, 3);
assert.strictEqual(L1.stars[2].name, '调研');
assert.deepStrictEqual(L1.stars.map(s => s.today), [false, false, true, true]);
assert.deepStrictEqual(L1.lines.map(l => [l.q, l.parent, l.pts.length]), [[1, 'pA', 3]]);
for (const s of L1.stars) assert.ok(s.x >= 6 && s.x <= 94 && s.y >= 8 && s.y <= 92);
// 确定性，且之后再完成任务不会挪动之前的星星
assert.deepStrictEqual(T.skyLayout(sk, spt, 19), L1);
const L2 = T.skyLayout(sk, spt, 20);
for (let i = 0; i < 4; i++) assert.deepStrictEqual([L2.stars[i].x, L2.stars[i].y], [L1.stars[i].x, L1.stars[i].y]);
const L3 = T.skyLayout([...sk, sd(8, 19, 'g', 75, 40, true)], spt, 19);
for (const s of L1.stars.filter(s => s.day < 19)) {
  const m = L3.stars.find(x => x.key === s.key);
  assert.deepStrictEqual([m.x, m.y], [s.x, s.y]);
}
// 同名同日的两条任务各有一颗星
const dupL = T.skyLayout([sd(1, 18, 'x', 75, 20, true), sd(2, 18, 'x', 75, 22, true)], [], 18);
assert.notStrictEqual(dupL.stars[0].key, dupL.stars[1].key);
assert.deepStrictEqual(T.dustLayout(7, 10), T.dustLayout(7, 10));
assert.strictEqual(T.dustLayout(7, 10).length, 10);
// river：经过 1、3、4 象限，不进「排时间做」，结果确定
const qOfPt = p => (p.x < 0.5 ? (p.y < 0.5 ? 2 : 3) : (p.y < 0.5 ? 1 : 4));
const hits = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (let i = 0; i <= 200; i++) {
  const p = T.riverAt(i / 200);
  if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) hits[qOfPt(p)]++;
}
assert.strictEqual(hits[2], 0);
for (const q of [1, 3, 4]) assert.ok(hits[q] > 30, `river q${q}: ${hits[q]}`);
const rv = T.riverLayout(99, 260);
assert.strictEqual(rv.length, 272);
assert.deepStrictEqual(T.riverLayout(99, 260), rv);
assert.ok(rv.every(s => !(s.x < 0.47 && s.y < 0.47)));
console.log('ALL PASS');
