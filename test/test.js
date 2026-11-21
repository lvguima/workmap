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
// galaxy：曲线在看板内斜穿，布局确定
const g0 = T.galaxyAt(0); const g1 = T.galaxyAt(1);
assert.ok(g0.x < 0 && g0.y > 0.9 && g1.x > 1 && g1.y < 0.15);
// 不穿过四个象限交汇的中心
for (let i = 0; i <= 200; i++) { const p = T.galaxyAt(i / 200); assert.ok(Math.hypot(p.x - 0.5, p.y - 0.5) > 0.12); }
for (let i = 0; i <= 20; i++) assert.ok(T.galaxyWidth(i / 20) > 0.4);
const gl = T.galaxyLayout(99);
assert.deepStrictEqual(T.galaxyLayout(99), gl);
assert.notDeepStrictEqual(T.galaxyLayout(98).stars[0], gl.stars[0]);
assert.strictEqual(gl.bright.length, 16);
assert.ok(gl.stars.length > 2000);
// ---------- 自动顺延 ----------
const mkPeriod = path => T.parsePeriod({ path });
const cp = mkPeriod('2026/11/18-30.md');
const cl = [
  '## 周期任务', '', '---', '',
  '## 20', '', '- [ ] 今天的', '',
  '## 19', '', '- [ ] 没做完 %%t:09-11%% %%m:75,20%%', '  备注', '- [x] 做完了', '- [>] 早就顺延了', '- [ ]', '',
  '## 18', '', '- [ ] 更早的',
];
const today20 = moment('2026-11-20', 'YYYY-MM-DD');
const ci = T.collectCarry(cl, cp, today20);
assert.deepStrictEqual(ci.map(i => i.info.text), ['没做完', '更早的']);
// 清掉时段，保留象限和备注
assert.deepStrictEqual(ci[0].block, ['- [ ] 没做完 %%m:75,20%%', '  备注']);
assert.strictEqual(ci[0].info.from, '11/19');
const cl2 = [...cl];
T.markCarried(cl2, ci);
assert.strictEqual(cl2[10], '- [>] 没做完 %%t:09-11%% %%m:75,20%%');
assert.strictEqual(cl2[18], '- [>] 更早的');
// 标记后再收集，什么都不会重复
assert.strictEqual(T.collectCarry(cl2, cp, today20).length, 0);

// ---------- 输入法回车 ----------
assert.strictEqual(T.isSubmitKey({ key: 'Enter', isComposing: false, keyCode: 13 }), true);
assert.strictEqual(T.isSubmitKey({ key: 'Enter', isComposing: true, keyCode: 13 }), false);
assert.strictEqual(T.isSubmitKey({ key: 'Enter', isComposing: false, keyCode: 229 }), false);

// ---------- 新建一期 ----------
const P = [mkPeriod('2026/11/1-10.md'), mkPeriod('2026/11/11-17.md'), mkPeriod('2026/11/18-30.md'), mkPeriod('2026/12/15-31.md')]
  .sort((a, b) => b.startDate.valueOf() - a.startDate.valueOf());
const D = s => moment(s, 'YYYY-MM-DD', true);
assert.strictEqual(T.periodProblem(D('2026-12-01'), D('2026-12-10'), P), '');
assert.match(T.periodProblem(D('2026-12-10'), D('2026-12-01'), P), /不能早于/);
assert.match(T.periodProblem(D('2026-12-25'), D('2027-01-03'), P), /同一个月/);
assert.match(T.periodProblem(D('2026-11-25'), D('2026-11-30'), P), /重叠/);
assert.match(T.periodProblem(D('2026-12-10'), D('2026-12-20'), P), /重叠/);
assert.match(T.periodProblem(D('2026-02-30'), D('2026-02-31'), P), /格式/);
// 今天在 11/18-30 里：从 12/1 开始，到 12/10
let sg = T.suggestPeriod(D('2026-11-20'), P);
assert.deepStrictEqual([sg.start.format('YYYY-MM-DD'), sg.end.format('YYYY-MM-DD')], ['2026-12-01', '2026-12-10']);
// 今天在 11/1-10，后面几期都建好了：跳过它们，从 12/1 开始
sg = T.suggestPeriod(D('2026-11-05'), P);
assert.strictEqual(sg.start.format('YYYY-MM-DD'), '2026-12-01');
// 结束日碰到后面已有的一期，停在它前一天
assert.strictEqual(T.periodEndFor(D('2026-12-11'), P).format('YYYY-MM-DD'), '2026-12-14');
assert.strictEqual(T.periodEndFor(D('2026-12-01'), P).format('YYYY-MM-DD'), '2026-12-10');

// ---------- 模板 ----------
const blocks = [['- [ ] 主线 A %%id:pa%%', '  备注'], ['- [ ] 主线 B']];
assert.strictEqual(T.fillTemplate('## 周期任务\n\n{{tasks}}\n\n---\n\n## {{day}}\n', blocks, '01'),
  '## 周期任务\n\n- [ ] 主线 A %%id:pa%%\n  备注\n- [ ] 主线 B\n\n---\n\n## 01\n');
// 模板里没有 {{tasks}}：放到「## 周期任务」下面
assert.strictEqual(T.fillTemplate('# 计划\n## 周期任务\n\n---\n## {{day}}\n', blocks, '01'),
  '# 计划\n## 周期任务\n\n- [ ] 主线 A %%id:pa%%\n  备注\n- [ ] 主线 B\n\n---\n## 01\n');
// 连「## 周期任务」都没有：加在最前面
const noSec = T.fillTemplate('## {{day}}\n', blocks, '01');
assert.ok(noSec.startsWith('## 周期任务\n\n- [ ] 主线 A %%id:pa%%\n  备注\n- [ ] 主线 B\n\n## 01'));
assert.strictEqual(T.fillTemplate('## {{day}}\n', [], '01'), '## 01\n');
// 任务文字里的 {{day}} 不会被替换
assert.ok(T.fillTemplate('{{tasks}}\n## {{day}}', [['- [ ] 写 {{day}} 模板']], '05').includes('写 {{day}} 模板'));

// ---------- 无效日期 ----------
assert.ok(Number.isNaN(T.daysUntil('2026-02-30')));
assert.strictEqual(T.countdown('2026-02-30').short, '日期无效');
// ---------- 时区 ----------
const zi = new Date('2026-11-21T02:40:00Z');
assert.strictEqual(T.momentIn(zi, 'America/Chicago').format('YYYY-MM-DD HH:mm'), '2026-11-20 20:40');
assert.strictEqual(T.momentIn(zi, 'Asia/Hong_Kong').format('YYYY-MM-DD HH:mm'), '2026-11-21 10:40');
assert.strictEqual(T.momentIn(zi, 'Europe/Paris').format('YYYY-MM-DD HH:mm'), '2026-11-21 03:40');
// 夏令时
const zs = new Date('2026-07-01T12:00:00Z');
assert.strictEqual(T.momentIn(zs, 'America/New_York').format('HH:mm'), '08:00');
assert.strictEqual(T.momentIn(zs, 'Europe/Paris').format('HH:mm'), '14:00');
// 午夜不能变成 24 点
assert.strictEqual(T.zoneParts(new Date('2026-11-20T16:00:00Z'), 'Asia/Hong_Kong').hour, 0);
assert.strictEqual(T.utcOffsetLabel(zi, 'Asia/Hong_Kong'), 'UTC+8');
assert.strictEqual(T.utcOffsetLabel(zi, 'America/Chicago'), 'UTC-6');
assert.strictEqual(T.utcOffsetLabel(zs, 'Europe/Paris'), 'UTC+2');
assert.strictEqual(T.zoneTz('us', 'America/Denver'), 'America/Denver');
assert.strictEqual(T.zoneTz('hk', 'America/Denver'), 'Asia/Hong_Kong');
assert.strictEqual(T.zoneTz('', 'America/Denver'), '');
assert.strictEqual(T.guessZone('America/Chicago'), 'us');
assert.strictEqual(T.guessZone('Europe/Paris'), 'paris');
assert.strictEqual(T.guessZone('Asia/Tokyo'), '');

// 切时区不写笔记；「今天」往后跳时先不顺延，确认后才顺延
async function zoneFlow() {
  const RealDate = Date;
  let fixed = new RealDate('2026-11-21T02:40:00Z').getTime();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
  try {
    const Plugin = require('../main.js');
    const note = ['## 周期任务', '', '---', '', '## 20', '', '- [ ] 没做完 %%m:75,20%%', ''].join('\n');
    const file = { path: '2026/11/18-30.md', data: note };
    const pl = new Plugin();
    pl.app = {
      vault: {
        getMarkdownFiles: () => [file],
        read: async f => f.data,
        process: async (f, fn) => { f.data = fn(f.data); return f.data; },
      },
      workspace: { getLeavesOfType: () => [] },
    };
    pl.saveData = async () => {};
    pl.settings = { carry: null, carryHold: '', zone: 'us', usZone: 'America/Chicago' };
    await pl.setZone('us');
    await pl.setZone('hk');
    assert.strictEqual(pl.settings.carryHold, '2026-11-21');
    assert.strictEqual(file.data, note);
    const hkToday = moment('2026-11-21', 'YYYY-MM-DD');
    assert.strictEqual(await pl.carryOver(hkToday), 0);
    assert.strictEqual(file.data, note);
    assert.strictEqual((await pl.pendingCarry(hkToday)).length, 1);
    // 切回去：今天往前，解除暂缓，笔记没变
    await pl.setZone('us');
    assert.strictEqual(pl.settings.carryHold, '');
    assert.strictEqual(file.data, note);
    // 再切过去并确认顺延
    await pl.setZone('paris');
    assert.strictEqual(pl.settings.carryHold, '2026-11-21');
    await pl.releaseCarry();
    assert.strictEqual(await pl.carryOver(hkToday), 1);
    assert.ok(file.data.includes('- [>] 没做完'));
    assert.ok(/## 21\n[\s\S]*- \[ \] 没做完/.test(file.data));
    // 到了下一天，暂缓自动失效
    pl.settings.carryHold = '2026-11-21';
    assert.strictEqual(pl.carryHeld(moment('2026-11-22', 'YYYY-MM-DD')), false);
    await pl.setZone('us');
  } finally {
    global.Date = RealDate;
  }
}
zoneFlow().then(() => console.log('ALL PASS')).catch(e => { console.error(e); process.exit(1); });
