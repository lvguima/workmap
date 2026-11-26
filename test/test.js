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
assert.strictEqual(T.longestRun(new Set([18, 19, 21]), 18, 21), 2);
assert.strictEqual(T.longestRun(new Set(), 18, 21), 0);
const st = T.periodStats({
  periodTasks: [{ done: true }, { done: true }],
  allDaily: [
    { done: true, day: 18 }, { done: false, day: 18 }, { done: true, day: 19 },
    { done: true, cancelled: true, day: 20 }, { done: true, day: 22 },
  ],
  start: 18,
  end: 30,
  day: 20,
});
assert.deepStrictEqual(st, {
  periodDone: 2, periodTotal: 2, dailyDone: 3, dailyTotal: 4,
  activeDays: 2, bestRun: 2, nth: 3, total: 13,
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
// 清掉时段，保留象限和备注，记下最初安排的日期
assert.deepStrictEqual(ci[0].block, ['- [ ] 没做完 %%c:2026-11-19%% %%m:75,20%%', '  备注']);
assert.strictEqual(ci[0].info.from, '11/19');
assert.strictEqual(ci[0].info.since, '2026-11-19');
assert.deepStrictEqual(ci[1].block, ['- [ ] 更早的 %%c:2026-11-18%%']);
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
    pl.history = [];
    pl.autoWrites = new Map();
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

// ---------- 0.6.0：任务状态 ----------
const sDoing = T.parseTaskLine('- [/] 写到一半 %%m:75,20%%', 0);
assert.strictEqual(sDoing.doing, true);
assert.strictEqual(sDoing.done, false);
assert.strictEqual(T.formatTask(sDoing), '- [/] 写到一半 %%m:75,20%%');
assert.strictEqual(T.formatTask(Object.assign({}, sDoing, { done: true })), '- [x] 写到一半 %%m:75,20%%');
const sCan = T.parseTaskLine('- [-] 不做了', 0);
assert.deepStrictEqual([sCan.done, sCan.cancelled], [true, true]);
assert.strictEqual(T.formatTask(sCan), '- [-] 不做了');
// 取消勾选已取消的任务 → 恢复成未开始
assert.strictEqual(T.formatTask(Object.assign({}, sCan, { done: false })), '- [ ] 不做了');
assert.strictEqual(T.parseTaskLine('- [>] 已顺延', 0), null);
assert.strictEqual(T.parseTaskLine('- [?] 别的插件的状态', 0), null);
// %%c%% 读写
const sc = T.parseTaskLine('- [ ] a %%p:px%% %%c:2026-11-19%% %%m:75,25%%', 0);
assert.strictEqual(sc.since, '2026-11-19');
assert.strictEqual(sc.text, 'a');
assert.strictEqual(T.formatTask(sc), '- [ ] a %%p:px%% %%c:2026-11-19%% %%m:75,25%%');
assert.strictEqual(T.parseTaskLine('- [ ] a %%c:乱写%%', 0).since, '');
// 进行中的任务也会顺延，已取消的不会
const sl = ['## 周期任务', '---', '## 20', '## 19', '- [/] 进行中 %%m:75,20%%', '- [-] 取消了'];
const sci = T.collectCarry(sl, cp, today20);
assert.deepStrictEqual(sci.map(i => i.block[0]), ['- [/] 进行中 %%c:2026-11-19%% %%m:75,20%%']);
T.markCarried(sl, sci);
assert.strictEqual(sl[4], '- [>] 进行中 %%m:75,20%%');

// ---------- 拖了几天 ----------
// 老笔记：没有 %%c%%，从同名 [>] 一路往前找；中间断开就停
const ol = [
  '## 周期任务', '---',
  '## 26', '- [ ] TIM %%m:75,25%%', '- [ ] 新的',
  '## 25', '- [>] TIM %%m:75,25%%', '- [>] 新的',
  '## 24', '- [>] TIM %%m:75,25%%',
  '## 22', '- [>] TIM %%t:09-11%% %%m:75,18%%',
  '## 21', '- [x] 别的',
  '## 19', '- [>] TIM',
];
assert.strictEqual(T.chainOrigin(ol, cp, 'TIM', 26), '2026-11-22');
assert.strictEqual(T.chainOrigin(ol, cp, '新的', 26), '2026-11-25');
assert.strictEqual(T.chainOrigin(ol, cp, '没有', 26), '');
// [>] 上带着 %%c%% 就直接用
assert.strictEqual(T.chainOrigin(['## 26', '## 25', '- [>] X %%c:2026-11-02%%'], cp, 'X', 26), '2026-11-02');
assert.strictEqual(T.carryAge('2026-11-19', moment('2026-11-26', 'YYYY-MM-DD')), 7);
assert.strictEqual(T.carryAge('', moment('2026-11-26', 'YYYY-MM-DD')), 0);
// 顺延时把找到的最初日期写进 %%c%%
const oc = T.collectCarry(ol, cp, moment('2026-11-27', 'YYYY-MM-DD'));
assert.strictEqual(oc.find(i => i.info.text === 'TIM').info.since, '2026-11-22');
assert.strictEqual(oc.find(i => i.info.text === '新的').info.since, '2026-11-25');

// ---------- 顺延时删掉原行 ----------
const mv = ['## 周期任务', '---', '## 20', '## 19', '- [ ] A', '  备注 A', '- [x] B', '- [ ] C', '## 18', '- [ ] D'];
const mvi = T.collectCarry(mv, cp, today20);
const mv2 = mv.slice();
T.markCarried(mv2, mvi, 'move');
assert.deepStrictEqual(mv2, ['## 周期任务', '---', '## 20', '## 19', '- [x] B', '## 18']);
T.unmarkCarried(mv2, mvi, 'move');
for (const l of ['- [ ] A', '  备注 A', '- [ ] C', '- [ ] D']) assert.ok(mv2.includes(l), l);
assert.ok(mv2.indexOf('  备注 A') === mv2.indexOf('- [ ] A') + 1);
// mark 模式的还原
const mk2 = mv.slice();
const mki = T.collectCarry(mk2, cp, today20);
T.markCarried(mk2, mki, 'mark');
assert.ok(mk2.includes('- [>] A'));
T.unmarkCarried(mk2, mki, 'mark');
assert.deepStrictEqual(mk2, mv);

// ---------- 周期任务排序 ----------
const pl0 = ['## 周期任务', '', '- [ ] A', '  备注', '- [ ] B ★★', '- [x] C', '', '---'];
const pr0 = () => T.periodRange(pl0);
let ml = pl0.slice();
assert.ok(T.moveTaskBlock(ml, T.periodRange(ml), '- [ ] A', '- [x] C'));
assert.deepStrictEqual(ml.slice(2, 6), ['- [ ] B ★★', '- [ ] A', '  备注', '- [x] C']);
ml = pl0.slice();
assert.ok(T.moveTaskBlock(ml, T.periodRange(ml), '- [ ] B ★★', '- [ ] A'));
assert.deepStrictEqual(ml.slice(2, 6), ['- [ ] B ★★', '- [ ] A', '  备注', '- [x] C']);
ml = pl0.slice();
assert.ok(T.moveTaskBlock(ml, T.periodRange(ml), '- [ ] A', ''));
assert.deepStrictEqual(ml, ['## 周期任务', '', '- [ ] B ★★', '- [x] C', '- [ ] A', '  备注', '', '---']);
ml = pl0.slice();
assert.strictEqual(T.moveTaskBlock(ml, T.periodRange(ml), '- [ ] 不存在', ''), false);
assert.strictEqual(T.moveTaskBlock(pl0.slice(), pr0(), '- [ ] A', '- [ ] 不存在'), false);

// ---------- 本期笔记 ----------
const nb = ['[🧭](obsidian://workmap)', '', '## 周期任务', '', '- [ ] A', '', '---', '', '## 26', '- [ ] x'];
const nb1 = nb.slice();
T.addNoteLink(nb1, T.noteLinkLine('2026/11/18-30/控制回路.md', '控制回路'));
assert.deepStrictEqual(nb1.slice(2), [
  '## 周期任务', '', '- [ ] A', '', '## 本期笔记', '', '- [[2026/11/18-30/控制回路|控制回路]]', '', '---', '', '## 26', '- [ ] x',
]);
// 周期任务区不受影响，天的小节也不受影响
assert.strictEqual(T.collectTasks(nb1, T.periodRange(nb1), 'period').length, 1);
assert.deepStrictEqual(T.listDays(nb1).map(d => d.day), [26]);
T.addNoteLink(nb1, T.noteLinkLine('2026/11/18-30/第二篇.md', '第二篇'));
assert.deepStrictEqual(T.listNoteLinks(nb1).map(l => [l.link, l.title]), [
  ['2026/11/18-30/控制回路', '控制回路'], ['2026/11/18-30/第二篇', '第二篇'],
]);
// 新的周期任务仍然加在周期任务区里
assert.strictEqual(T.periodRange(nb1).end, nb1.indexOf('## 本期笔记'));
assert.strictEqual(T.noteLinkLine('a/b.md', 'x|y]'), '- [[a/b|x y]]');
assert.deepStrictEqual(T.listNoteLinks(['## 本期笔记', '- [[a#标题|A]]', '随手写的一行', '- [[b]]']).map(l => [l.link, l.title]), [['a', 'A'], ['b', '']]);

// ---------- 游离内容 ----------
const sb = [
  '[🧭](obsidian://workmap)', '', '## 周期任务', '- [ ] A', '', '---',
  '# 控制回路学习笔记', '', '## 0. 先记住', '内容', '', '---', '', '## 1. 概念', '|表|格|', '', '',
  '## 26', '- [ ] x', '',
  '## 25', '- [>] x',
];
const sbs = T.strayBlocks(sb);
assert.deepStrictEqual(sbs, [{ start: 6, end: 15 }]);
assert.strictEqual(T.strayTitle(sb.slice(6, 15)), '控制回路学习笔记');
const sb2 = sb.slice();
const taken = T.takeStray(sb2);
assert.strictEqual(taken.length, 1);
assert.strictEqual(taken[0].title, '控制回路学习笔记');
assert.ok(taken[0].text.startsWith('# 控制回路学习笔记\n\n## 0. 先记住'));
assert.ok(taken[0].text.includes('\n---\n\n## 1. 概念\n|表|格|\n'));
assert.deepStrictEqual(sb2, ['[🧭](obsidian://workmap)', '', '## 周期任务', '- [ ] A', '', '---', '', '## 26', '- [ ] x', '', '## 25', '- [>] x']);
assert.deepStrictEqual(T.strayBlocks(sb2), []);
// 前言、本期笔记里的链接、每天小节里的 ### 标题都不算游离内容
assert.deepStrictEqual(T.strayBlocks(['# 我的计划', '说明', '## 周期任务', '## 本期笔记', '- [[a]]', '---', '## 26', '### 会议', '记录']), []);
// 最后一天后面又贴了一段带二级标题的内容
assert.deepStrictEqual(T.strayBlocks(['## 周期任务', '---', '## 26', '- [ ] x', '## 附录', '内容']), [{ start: 4, end: 6 }]);
assert.strictEqual(T.strayTitle(['', '**粗体** 开头的一段话，没有标题，比较长比较长比较长比较长比较长']), '粗体 开头的一段话，没有标题，比较长比较长比较长比较长比');
assert.strictEqual(T.safeFileName('a/b:c?'), 'a b c');
assert.strictEqual(T.safeFileName('###'), '未命名笔记');

// ---------- 给大模型的摘要 ----------
const dg = T.periodDigest({
  p: cp,
  today: moment('2026-11-26', 'YYYY-MM-DD'),
  lines: [
    '## 周期任务', '- [ ] 论文返修 ★★★ 📅 2026-12-02 %%id:pf%%', '  先回审稿人 2', '- [x] 报告 %%id:pq%%',
    '---',
    '## 26', '- [ ] 回复审稿意见 %%p:pf%% %%m:75,25%%', '- [/] 读材料 %%m:25,75%%',
    '## 25', '- [>] 回复审稿意见 %%p:pf%% %%m:75,25%%', '- [x] 报告终稿 %%p:pq%% %%m:75,30%%',
    '## 24', '- [>] 回复审稿意见 %%p:pf%% %%m:75,25%%',
  ],
  notes: [{ title: '控制回路', text: '# 控制回路\nSP、PV、OP' }],
});
assert.ok(!dg.includes('%%'));
assert.ok(dg.includes('今天是 2026-11-26，本期第 9 天'));
assert.ok(dg.includes('- [未完成] 论文返修 · 重要程度：最重要 · 截止 2026-12-02 · 拆出的每日任务完成 0/1'));
assert.ok(dg.includes('  先回审稿人 2'));
assert.ok(dg.includes('- [未完成] 回复审稿意见 ← 主线「论文返修」 · 重要且紧急 · 最早安排在 2026-11-24，已拖 2 天'));
assert.ok(dg.includes('- [进行中] 读材料 · 不重要不紧急'));
assert.ok(dg.includes('### 11/24 周二'));
assert.ok(dg.includes('（另有 1 项当天没做完，顺延到了后面）'));
assert.ok(dg.indexOf('### 11/24') < dg.indexOf('### 11/26'));
assert.ok(dg.includes('### 《控制回路》'));

// ---------- 插件：本期笔记、整理游离内容、排序、调用模型 ----------
async function notesFlow() {
  const Plugin = require('../main.js');
  const files = new Map();
  const folders = new Set();
  const mkFile = (path, data) => {
    const name = path.split('/').pop();
    const f = { path, data, basename: name.replace(/\.md$/, ''), extension: 'md', stat: { mtime: 0 } };
    files.set(path, f);
    return f;
  };
  const periodFile = mkFile('2026/11/18-30.md', [
    '## 周期任务', '', '- [ ] A ★', '- [ ] B ★★★', '', '---', '',
    '# 学习笔记', '', '## 1. 概念', '内容', '', '---', '', '## 2. 更多', '更多内容', '',
    '## 26', '- [ ] x', '',
  ].join('\n'));
  const pl = new Plugin();
  pl.app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      read: async f => f.data,
      cachedRead: async f => f.data,
      process: async (f, fn) => { f.data = fn(f.data); return f.data; },
      getAbstractFileByPath: p => files.get(p) || (folders.has(p) ? { path: p, children: [] } : null),
      createFolder: async p => { folders.add(p); },
      create: async (p, data) => {
        if (files.has(p)) throw new Error('exists');
        return mkFile(p, data);
      },
    },
    fileManager: { trashFile: async f => { files.delete(f.path); } },
    metadataCache: {
      getFirstLinkpathDest: l => files.get(l + '.md') || null,
      getFileCache: () => null,
    },
    workspace: { getLeavesOfType: () => [] },
  };
  pl.saveData = async () => {};
  pl.history = [];
  pl.autoWrites = new Map();
  pl.settings = Object.assign({}, { carry: null, carryHold: '', carryMode: 'mark', aiKey: '', aiBase: 'https://www.dmxapi.cn/v1', aiModel: 'claude-sonnet-5-5' });
  const period = pl.periods()[0];
  assert.strictEqual(pl.notesFolder(period), '2026/11/18-30');

  // 整理游离内容：原文完整挪到新文件，时段笔记里只留链接
  assert.strictEqual(await pl.archiveStray(period), 1);
  const note = files.get('2026/11/18-30/学习笔记.md');
  assert.ok(note);
  assert.strictEqual(note.data, '# 学习笔记\n\n## 1. 概念\n内容\n\n---\n\n## 2. 更多\n更多内容\n');
  assert.deepStrictEqual(periodFile.data.split('\n'), [
    '## 周期任务', '', '- [ ] A ★', '- [ ] B ★★★', '', '## 本期笔记', '', '- [[2026/11/18-30/学习笔记|学习笔记]]', '', '---', '',
    '## 26', '- [ ] x', '',
  ]);
  assert.strictEqual(await pl.archiveStray(period), 0);
  const ns = pl.notesOf(period, periodFile.data.split('\n'));
  assert.deepStrictEqual(ns.map(n => [n.title, n.listed, !!n.file]), [['学习笔记', true, true]]);

  // 同名笔记不覆盖
  const f2 = await pl.createNote(period, '学习笔记', '# 学习笔记\n');
  assert.strictEqual(f2.path, '2026/11/18-30/学习笔记 2.md');
  assert.strictEqual(pl.notesOf(period, periodFile.data.split('\n')).length, 2);
  await pl.unlinkNote(period, listNoteLinksOf(periodFile)[1]);
  assert.strictEqual(listNoteLinksOf(periodFile).length, 1);

  // 周期任务拖动排序：B 拖到 A 前面
  const pts = T.collectTasks(periodFile.data.split('\n'), T.periodRange(periodFile.data.split('\n')), 'period');
  assert.ok(await pl.movePeriodTask(periodFile, pts[1], pts[0]));
  assert.ok(periodFile.data.startsWith('## 周期任务\n\n- [ ] B ★★★\n- [ ] A ★\n'));

  // 调用模型：没有密钥直接报错；HTTP 错误把 DMXAPI 的说明带出来；正常时取 choices[0].message.content
  await assert.rejects(pl.chat('s', 'u'), /API 密钥/);
  pl.settings.aiKey = 'sk-test';
  let sent = null;
  pl._request = async req => { sent = req; return { status: 503, json: { error: { message: '模型 xx 无可用渠道' } } }; };
  await assert.rejects(pl.chat('s', 'u'), /HTTP 503 · 这个模型现在不可用，检查模型名：模型 xx 无可用渠道/);
  assert.strictEqual(sent.url, 'https://www.dmxapi.cn/v1/chat/completions');
  assert.strictEqual(sent.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(sent.body);
  assert.strictEqual(body.model, 'claude-sonnet-5-5');
  assert.deepStrictEqual(body.messages.map(m => m.role), ['system', 'user']);
  pl._request = async () => ({ status: 200, json: { model: 'claude-sonnet-5-5', choices: [{ message: { content: ' 你好 ' }, finish_reason: 'stop' }] } });
  assert.deepStrictEqual(await pl.chat('s', 'u'), { text: '你好', model: 'claude-sonnet-5-5', truncated: false });
  pl._request = async () => ({ status: 200, get json() { throw new Error('not json'); } });
  await assert.rejects(pl.chat('s', 'u'), /HTTP 200/);
}
function listNoteLinksOf(f) { return T.listNoteLinks(f.data.split('\n')); }

// 回归：不能把几年前的往期任务都顺延到今天。没设起点只看上一期；设了起点，早于起点的不管
async function carryScopeFlow() {
  const Plugin = require('../main.js');
  const mk = (path, data) => ({ path, data });
  const files = [
    mk('2025/10/10-20.md', '## 周期任务\n---\n## 18\n- [ ] 前年的任务\n'),
    mk('2026/11/1-10.md', '## 周期任务\n---\n## 9\n- [ ] 上一期的任务\n'),
    mk('2026/11/18-30.md', '## 周期任务\n---\n## 25\n- [ ] 昨天的\n## 17\n- [ ] 起点之前的\n'),
  ];
  const make = settings => {
    const pl = new Plugin();
    pl.app = {
      vault: {
        getMarkdownFiles: () => files,
        read: async f => f.data,
        process: async (f, fn) => { f.data = fn(f.data); return f.data; },
      },
      workspace: { getLeavesOfType: () => [] },
    };
    pl.saveData = async () => {};
    pl.history = [];
    pl.autoWrites = new Map();
    pl.settings = Object.assign({ carry: null, carryHold: '', carryMode: 'mark', carryStart: '' }, settings);
    return pl;
  };
  const snap = files.map(f => f.data);
  const d26 = moment('2026-11-26', 'YYYY-MM-DD');
  assert.deepStrictEqual((await make({}).pendingCarry(d26)).map(i => i.info.text), ['上一期的任务', '昨天的', '起点之前的']);
  assert.deepStrictEqual((await make({ carryStart: '2026-11-18' }).pendingCarry(d26)).map(i => i.info.text), ['昨天的']);
  assert.strictEqual(await make({ carryStart: '2026-11-18' }).carryOver(d26), 1);
  assert.strictEqual(files[0].data, snap[0]);
  assert.strictEqual(files[1].data, snap[1]);
  assert.ok(files[2].data.includes('- [ ] 起点之前的'));
  assert.ok(files[2].data.includes('- [>] 昨天的'));
}

// ---------- 工作助理：纯函数 ----------
{
  const base = 'https://www.dmxapi.cn/v1/';
  const rc = T.buildChatRequest({ base, key: 'k', model: 'claude-sonnet-5-5', effort: 'high', system: 'S', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.strictEqual(rc.url, 'https://www.dmxapi.cn/v1/messages');
  assert.strictEqual(rc.headers['x-api-key'], 'k');
  assert.deepStrictEqual(rc.body.output_config, { effort: 'high' });
  assert.deepStrictEqual(rc.body.thinking, { type: 'adaptive' });
  assert.strictEqual(rc.body.system, 'S');
  for (const id of ['deepseek-v4.1-flash', 'gemini-4-hydrogen']) {
    const ro = T.buildChatRequest({ base, key: 'k', model: id, effort: 'low', system: 'S', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.strictEqual(ro.url, 'https://www.dmxapi.cn/v1/chat/completions');
    assert.strictEqual(ro.headers.Authorization, 'Bearer k');
    assert.strictEqual(ro.body.reasoning_effort, 'low');
    assert.deepStrictEqual(ro.body.messages.map(m => m.role), ['system', 'user']);
    assert.deepStrictEqual(ro.body.stream_options, { include_usage: true });
  }
  assert.strictEqual(T.buildChatRequest({ base, key: 'k', model: 'x', effort: 'low', system: '', messages: [], stream: false }).body.stream_options, undefined);
  assert.strictEqual(T.agentModel('claude-opus-5-5').api, 'anthropic');

  // SSE：一行被拆在两块里也能拼起来
  let r = T.sseSplit('data: {"a":1}\n\ndata: {"b"');
  assert.deepStrictEqual(r.events, [{ a: 1 }]);
  r = T.sseSplit(r.rest + ':2}\ndata: [DONE]\nevent: ping\ndata: 不是json\n');
  assert.deepStrictEqual(r.events, [{ b: 2 }]);
  assert.strictEqual(r.rest, '');
  // 两种接口的事件
  assert.strictEqual(T.streamDelta('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }).text, '你');
  assert.strictEqual(T.streamDelta('anthropic', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } }).thinking, '想');
  assert.deepStrictEqual(T.streamDelta('anthropic', { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 9, cost: '¥0.01' } }).usage, { input: 3, output: 9, cost: '¥0.01' });
  assert.strictEqual(T.streamDelta('anthropic', { type: 'error', error: { message: '过载' } }).error, '过载');
  const od = T.streamDelta('openai', { choices: [{ delta: { content: 'a', reasoning_content: 'r' } }] });
  assert.deepStrictEqual([od.text, od.thinking], ['a', 'r']);
  assert.deepStrictEqual(T.streamDelta('openai', { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } }).usage, { input: 5, output: 7 });
  assert.deepStrictEqual(T.replyOf('anthropic', { content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: 'x' }] }).text, 'x');
  assert.strictEqual(T.replyOf('openai', { choices: [{ message: { content: 'y', reasoning_content: 'z' } }] }).thinking, 'z');

  // 操作块
  const pa = T.parseActions('先做 A。\n\n```workmap\n[{"op":"add","text":"A","quad":1},{"op":"rm","task":"x"},{"op":"done","task":"B"}]\n```\n');
  assert.strictEqual(pa.text, '先做 A。');
  assert.deepStrictEqual(pa.actions.map(a => a.op), ['add', 'done']);
  assert.deepStrictEqual(T.parseActions('没有块').actions, []);
  assert.strictEqual(T.parseActions('```workmap\n不是 json\n```').actions.length, 0);
  assert.strictEqual(T.visibleReply('正文\n```workmap\n[{"op"'), '正文');
  assert.strictEqual(T.describeAction({ op: 'add', text: 'A', quad: 1, parent: '论文' }), '新增今天的任务到「马上做」：A（主线：论文）');
  assert.strictEqual(T.describeAction({ op: 'addPeriod', text: 'M', level: 2, due: '2026-12-01' }), '新增本期主线：M ★★ 📅 2026-12-01');
  const mt = [{ text: 'TIM_response：reviewer#2', done: false }, { text: '读材料', done: true }, { text: '读材料', done: false }];
  assert.strictEqual(T.matchTask(mt, '读材料'), mt[2]);
  assert.strictEqual(T.matchTask(mt, 'reviewer#2'), mt[0]);
  assert.strictEqual(T.matchTask(mt, '不存在'), null);
  assert.strictEqual(T.matchTask([{ text: '读 A' }, { text: '读 B' }], '读'), null); // 不唯一

  // 对话存档来回
  const chat = {
    title: '今天先做什么', created: '2026-11-26 09:30',
    messages: [
      { role: 'user', content: '今天先做什么？', time: '09:30' },
      { role: 'assistant', content: '先回 reviewer#2。\n\n### 理由\n截止最近。', model: 'Claude Sonnet 5.5', time: '09:31', actions: [{ op: 'add', text: '读意见', quad: 1, state: 'done' }] },
      { role: 'user', content: '好', time: '09:32' },
    ],
  };
  const md = T.formatChat(chat);
  assert.ok(md.startsWith('---\nworkmap: chat\ncreated: 2026-11-26 09:30\n---\n\n# 今天先做什么\n'));
  const back = T.parseChat(md);
  assert.strictEqual(back.title, '今天先做什么');
  assert.strictEqual(back.created, '2026-11-26 09:30');
  assert.deepStrictEqual(back.messages.map(m => [m.role, m.time]), [['user', '09:30'], ['assistant', '09:31'], ['user', '09:32']]);
  assert.strictEqual(back.messages[1].content, '先回 reviewer#2。\n\n### 理由\n截止最近。');
  assert.strictEqual(back.messages[1].model, 'Claude Sonnet 5.5');
  assert.deepStrictEqual(back.messages[1].actions, [{ op: 'add', text: '读意见', quad: 1, state: 'done' }]);
  assert.strictEqual(T.chatTitle('  帮我把「回复审稿意见」拆成小任务，放进合适的象限  '), '帮我把「回复审稿意见」拆成小任务，放进合适的象限');
assert.strictEqual(T.chatTitle('一二三四五六七八九十一二三四五六七八九十一二三四五六'), '一二三四五六七八九十一二三四五六七八九十一二三四');
assert.strictEqual(T.chatTitle('   '), '未命名笔记');

  // 上下文
  const ctxLines = [
    '## 周期任务', '- [ ] 论文 ★★★ %%id:pf%%', '---',
    '## 26', '- [ ] 回复意见 %%p:pf%% %%m:75,25%%',
    '## 25', '- [>] 回复意见 %%p:pf%% %%m:75,25%%', '- [x] 报告 %%m:75,30%%',
  ];
  const now = moment('2026-11-26 14:05', 'YYYY-MM-DD HH:mm');
  const curP = { p: cp, lines: ctxLines };
  const ctx = T.agentContext({ now, cur: curP, prev: curP, flags: { today: true, yesterday: true, period: true, notes: true }, notes: [{ title: 'N', text: '要点' }] });
  assert.ok(ctx.includes('现在：2026-11-26 周四 14:05'));
  assert.ok(ctx.includes('第 9 天，共 13 天'));
  assert.ok(ctx.includes('## 本期主线\n- [未完成] 论文 · 重要程度：最重要'));
  assert.ok(ctx.includes('## 今天的任务（11/26 周四）\n- [未完成] 回复意见 ← 主线「论文」 · 重要且紧急 · 最早安排在 2026-11-25，已拖 1 天'));
  assert.ok(ctx.includes('## 昨天的任务（11/25 周三）\n- [已完成] 报告'));
  assert.ok(ctx.includes('### 《N》'));
  const ctx2 = T.agentContext({ now, cur: curP, prev: null, flags: { today: true, yesterday: true, period: false, notes: false }, notes: [] });
  assert.ok(!ctx2.includes('本期主线'));
  assert.ok(ctx2.includes('## 昨天的任务（11/25 周三）\n（没有任务）'));
  assert.ok(T.agentContext({ now, cur: null, prev: null, flags: {}, notes: [] }).includes('还没有对应的时段笔记'));
  const sys = T.agentSystem(['09-11', '14-16'], 'CTX');
  assert.ok(sys.includes('09-11、14-16') && sys.endsWith('# 上下文\n\nCTX'));
  assert.ok(sys.includes('```workmap'));
}

// ---------- 工作助理：流式调用、执行建议、存对话 ----------
async function agentFlow() {
  const RealDate = Date;
  const fixed = new RealDate('2026-11-26T06:00:00Z').getTime(); // 香港 14:00
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
  try {
    const Plugin = require('../main.js');
    const files = new Map();
    const folders = new Set();
    const mkFile = (path, data) => {
      const f = { path, data, basename: path.split('/').pop().replace(/\.md$/, ''), extension: 'md', stat: { mtime: 1, ctime: 1 } };
      files.set(path, f);
      return f;
    };
    const pf = mkFile('2026/11/18-30.md', ['## 周期任务', '', '- [ ] 论文 ★★★ %%id:pf%%', '', '---', '', '## 26', '', '- [ ] 回复意见 %%p:pf%% %%m:75,25%%', '- [ ] 订会议室 %%m:75,75%%', ''].join('\n'));
    const pl = new Plugin();
    pl.app = {
      vault: {
        getMarkdownFiles: () => [...files.values()],
        read: async f => f.data,
        cachedRead: async f => f.data,
        modify: async (f, d) => { f.data = d; },
        process: async (f, fn) => { f.data = fn(f.data); return f.data; },
        getAbstractFileByPath: p => files.get(p) || (folders.has(p) ? { path: p, children: [] } : null),
        createFolder: async p => { folders.add(p); },
        create: async (p, d) => mkFile(p, d),
      },
      metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
      workspace: { getLeavesOfType: () => [] },
    };
    pl.saveData = async () => {};
    pl.history = [];
    pl.autoWrites = new Map();
    pl.settings = { carry: null, carryHold: '', carryMode: 'mark', carryStart: '2026-11-18', zone: 'hk', usZone: 'America/Chicago',
      slots: ['09-11', '14-16'], aiKey: 'sk-test', aiBase: 'https://www.dmxapi.cn/v1', agentModel: 'claude-sonnet-5-5', agentEffort: 'high' };
    await pl.setZone('hk');

    // 上下文里有今天的任务
    const ctx = await pl.agentContextFor({ today: true, yesterday: true, period: true, notes: false });
    assert.ok(ctx.includes('- [未完成] 回复意见 ← 主线「论文」'));

    // 流式：事件被拆成任意几块，结果照样拼完整；用量取最后一次
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先看截止"}}\n\ndata: {"type":"content_block_de',
      'lta","delta":{"type":"text_delta","text":"先回意见。"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\n\\n```workmap\\n[{\\"op\\":\\"move\\",\\"task\\":\\"订会议室\\",\\"quad\\":4}]\\n```"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":12,"cost":"¥0.003"}}\n\n',
    ];
    let sent = null;
    const enc = new TextEncoder();
    pl._fetch = async (url, init) => {
      sent = { url, init };
      let i = 0;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < sse.length ? { done: false, value: enc.encode(sse[i++]) } : { done: true }) }) } };
    };
    const seen = [];
    const r = await pl.streamChat({ model: 'claude-sonnet-5-5', effort: 'high', system: 'S', messages: [{ role: 'user', content: '今天先做什么' }], onDelta: a => seen.push(a.text) });
    assert.strictEqual(sent.url, 'https://www.dmxapi.cn/v1/messages');
    assert.strictEqual(JSON.parse(sent.init.body).output_config.effort, 'high');
    assert.strictEqual(r.thinking, '先看截止');
    assert.ok(r.text.startsWith('先回意见。'));
    assert.deepStrictEqual(r.usage, { input: 40, output: 12, cost: '¥0.003' });
    assert.ok(seen.length >= 2);
    const parsed = T.parseActions(r.text);
    assert.deepStrictEqual(parsed.actions, [{ op: 'move', task: '订会议室', quad: 4 }]);

    // HTTP 错误
    pl._fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"无效的令牌"}}' });
    await assert.rejects(pl.streamChat({ model: 'gemini-4-hydrogen', effort: 'low', system: 'S', messages: [] }), /HTTP 401 · 密钥无效：无效的令牌/);
    // fetch 失败（比如跨域）：退回一次性请求
    pl._fetch = async () => { throw new TypeError('Failed to fetch'); };
    pl._request = async req => ({ status: 200, json: { choices: [{ message: { content: '一次性' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }, req });
    const warn = console.warn; console.warn = () => {};
    assert.strictEqual((await pl.streamChat({ model: 'deepseek-v4.1-flash', effort: 'low', system: 'S', messages: [] })).text, '一次性');
    console.warn = warn;

    // 执行建议
    await pl.applyAction({ op: 'move', task: '订会议室', quad: 2 });
    await pl.applyAction({ op: 'add', text: '读 reviewer#2 第 1–3 条', quad: 1, parent: '论文' });
    await pl.applyAction({ op: 'doing', task: '回复意见' });
    await pl.applyAction({ op: 'slot', task: '回复意见', slot: '14-16' });
    await pl.applyAction({ op: 'addPeriod', text: '新主线', level: 2, due: '2026-12-01' });
    await assert.rejects(pl.applyAction({ op: 'done', task: '不存在的事' }), /找不到/);
    await assert.rejects(pl.applyAction({ op: 'slot', task: '回复意见', slot: '25-26' }), /没有「25-26」/);
    const ls = pf.data.split('\n');
    assert.ok(ls.includes('- [/] 回复意见 %%p:pf%% %%t:14-16%% %%m:75,25%%'), pf.data);
    assert.ok(ls.includes('- [ ] 读 reviewer#2 第 1–3 条 %%p:pf%% %%m:75,27%%'), pf.data);
    assert.ok(ls.some(l => /^- \[ \] 订会议室 %%m:\d+,\d+%%$/.test(l) && T.quadOf(T.parseTaskLine(l, 0)) === 2));
    assert.ok(ls.includes('- [ ] 新主线 ★★ 📅 2026-12-01 %%id:' + T.collectTasks(ls, T.periodRange(ls), 'period')[1].id + '%%'));
    // 每次执行都进撤销历史
    assert.strictEqual(pl.history.length, 5);

    // 存对话：放在本期文件夹的「对话」里，第二次保存改同一个文件
    const chat = { title: '今天先做什么', created: '2026-11-26 14:00', messages: [{ role: 'user', content: '今天先做什么', time: '14:00' }], file: null };
    const f = await pl.saveChat(chat);
    assert.strictEqual(f.path, '2026/11/18-30/对话/11-26 1400 今天先做什么.md');
    chat.messages.push({ role: 'assistant', content: '先回意见。', model: 'Claude Sonnet 5.5', time: '14:01', actions: parsed.actions });
    await pl.saveChat(chat);
    assert.strictEqual(files.get(f.path).data, T.formatChat(chat));
    assert.deepStrictEqual(pl.listChats().map(x => x.path), [f.path]);
    // 对话不算本期笔记
    assert.deepStrictEqual(pl.notesOf(pl.periods()[0], pf.data.split('\n')), []);
  } finally {
    global.Date = RealDate;
  }
}

// ---------- 周期任务迁移 ----------
{
  const src = ['## 周期任务', '', '- [ ] A ★★ %%id:pa%%', '  备注 A', '- [x] 做完的 %%id:pd%%', '- [ ] B %%id:pb%%', '', '---', '## 26'];
  const blocks = T.openPeriodBlocks(src);
  assert.deepStrictEqual(blocks.map(b => b.block), [['- [ ] A ★★ %%id:pa%%', '  备注 A'], ['- [ ] B %%id:pb%%']]);
  const dst = ['## 周期任务', '', '- [ ] B %%id:pb%%', '- [ ] 新一期自己加的', '', '---', '## 01'];
  assert.strictEqual(T.insertPeriodBlocks(dst, blocks), 1); // B 已经在了
  assert.deepStrictEqual(dst.slice(0, 7), ['## 周期任务', '', '- [ ] B %%id:pb%%', '- [ ] 新一期自己加的', '- [ ] A ★★ %%id:pa%%', '  备注 A', '']);
  const empty = ['## 周期任务', '', '---'];
  assert.strictEqual(T.insertPeriodBlocks(empty, blocks), 2);
  assert.deepStrictEqual(empty, ['## 周期任务', '', '- [ ] A ★★ %%id:pa%%', '  备注 A', '- [ ] B %%id:pb%%', '', '---']);
  const src2 = src.slice();
  T.removePeriodBlocks(src2, blocks);
  assert.deepStrictEqual(src2, ['## 周期任务', '', '- [x] 做完的 %%id:pd%%', '', '---', '## 26']);
}

// 回归：本期还没结束就新建下一期，不能把本期的周期任务搬空；等新一期开始那天再迁移
async function migrateFlow() {
  const RealDate = Date;
  let fixed = new RealDate('2026-11-26T04:00:00Z').getTime(); // 香港 11/26 中午
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
  try {
    const Plugin = require('../main.js');
    const files = new Map();
    const folders = new Set(['2026', '2026/11']);
    const mkFile = (path, data) => { const f = { path, data, basename: path.split('/').pop().replace(/\.md$/, ''), extension: 'md', stat: { mtime: 1 } }; files.set(path, f); return f; };
    const cur = mkFile('2026/11/18-30.md', ['## 周期任务', '', '- [ ] 启明星答辩 ★★★ %%id:pk%%', '  还要和杜老师讲一下', '- [x] 报告 %%id:pr%%', '- [ ] TIM ★★★ %%id:pf%%', '', '---', '', '## 26', '- [ ] 启明星：做 ppt %%p:pk%% %%m:75,25%%', ''].join('\n'));
    const before = cur.data;
    const pl = new Plugin();
    pl.app = {
      vault: {
        getMarkdownFiles: () => [...files.values()],
        read: async f => f.data,
        cachedRead: async f => f.data,
        process: async (f, fn) => { f.data = fn(f.data); return f.data; },
        getAbstractFileByPath: p => files.get(p) || (folders.has(p) ? { path: p, children: [] } : null),
        createFolder: async p => { folders.add(p); },
        create: async (p, d) => mkFile(p, d),
      },
      workspace: { getLeavesOfType: () => [] },
    };
    pl.saveData = async () => {};
    pl.history = [];
    pl.autoWrites = new Map();
    pl.settings = { carry: null, carryHold: '', carryStart: '2026-11-18', zone: 'hk', usZone: 'America/Chicago', migrations: [] };
    pl.loadTemplate = async () => '## 周期任务\n\n{{tasks}}\n\n---\n\n## {{day}}\n';
    await pl.setZone('hk');
    const D = x => moment(x, 'YYYY-MM-DD');

    // 11/26 提前新建 12/1-10：本期不动，只记下待迁移
    const nf = await pl.createPeriod(D('2026-12-01'), D('2026-12-10'), true);
    assert.strictEqual(cur.data, before);
    assert.ok(!nf.data.includes('启明星答辩'));
    assert.deepStrictEqual(pl.settings.migrations, [{ from: '2026/11/18-30.md', to: '2026/12/1-10.md' }]);
    assert.ok(pl.pendingMigration('2026/12/1-10.md'));
    // 新一期还没开始：什么都不做
    assert.strictEqual(await pl.runMigrations(D('2026-11-30')), 0);
    assert.strictEqual(cur.data, before);
    assert.strictEqual(pl.settings.migrations.length, 1);
    // 期间在本期完成了 TIM
    cur.data = cur.data.replace('- [ ] TIM ★★★ %%id:pf%%', '- [x] TIM ★★★ %%id:pf%%');
    // 12/1：没完成的（只剩启明星答辩，连同备注）搬过去，做完的留在本期
    assert.strictEqual(await pl.runMigrations(D('2026-12-01')), 1);
    assert.ok(nf.data.includes('- [ ] 启明星答辩 ★★★ %%id:pk%%\n  还要和杜老师讲一下'));
    assert.ok(!nf.data.includes('TIM'));
    assert.ok(!cur.data.includes('启明星答辩 ★★★'));
    assert.ok(cur.data.includes('- [x] TIM ★★★ %%id:pf%%'));
    assert.ok(cur.data.includes('- [x] 报告 %%id:pr%%'));
    assert.deepStrictEqual(pl.settings.migrations, []);
    assert.strictEqual(await pl.runMigrations(D('2026-12-02')), 0);

    // 上一期已经结束后再新建：照旧立刻迁移
    fixed = new RealDate('2026-12-11T04:00:00Z').getTime();
    nf.data = nf.data.replace('## 周期任务\n', '## 周期任务\n\n- [ ] 没做完的 %%id:px%%\n');
    const nf2 = await pl.createPeriod(D('2026-12-11'), D('2026-12-20'), true);
    assert.ok(nf2.data.includes('- [ ] 没做完的 %%id:px%%'));
    assert.ok(!nf.data.includes('没做完的'));
    assert.deepStrictEqual(pl.settings.migrations, []);
  } finally {
    global.Date = RealDate;
  }
}

zoneFlow()
  .then(notesFlow)
  .then(carryScopeFlow)
  .then(agentFlow)
  .then(migrateFlow)
  .then(() => console.log('ALL PASS'))
  .catch(e => { console.error(e); process.exit(1); });
