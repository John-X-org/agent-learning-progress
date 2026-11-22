/**
 * tools/mutate.js — 谁来自检自检：变异测试
 *
 * 做法：故意往代码里注入一个"常见错误"，然后跑对应的检查脚本。
 *   - 检查 FAIL（非 0 退出）→ 这个错误被抓住了（变异被杀死）✔
 *   - 检查照常 PASS → 说明整套自检根本管不到这块（变异存活）✘
 *
 * 用法：node tools/mutate.js            跑全部变异
 *      node tools/mutate.js M03        只跑某一个
 *
 * 判定：存活率必须为 0。有存活就说明"自检看起来全绿，其实是漏的"，
 *      要么补检查，要么承认这块没保护——不能放着不管。
 *
 * 注意：脚本会临时改写源文件，跑完一定还原（finally + 结束时统一兜底）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 5500 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alp-mutate-'));

const MUTATIONS = [
  {
    id: 'M01', file: 'server.js', expect: 'verify',
    note: '自测成绩不再取历史最好值（低分能冲掉高分）',
    find: 't.quizBest = t.quizBest == null ? pct : Math.max(t.quizBest, pct);',
    replace: 't.quizBest = pct;'
  },
  {
    id: 'M02', file: 'server.js', expect: 'verify',
    note: '记进度不再校验任务归属（能改别人的）',
    find: 'const t = db.tasks.find((x) => x.id === Number(pm[1]) && x.userId === user.id);',
    replace: 'const t = db.tasks.find((x) => x.id === Number(pm[1]));'
  },
  {
    id: 'M03', file: 'server.js', expect: 'verify',
    note: '导入笔记不再去重（重复导入会翻倍）',
    find: '      if (noteKeys.has(key)) { counts.skipped++; return; }',
    replace: '      if (false) { counts.skipped++; return; }'
  },
  {
    id: 'M04', file: 'server.js', expect: 'verify',
    note: '学完判定不再要求笔记',
    find: 'const done = read && quizPassed && (!needNote || hasNote);',
    replace: 'const done = read && quizPassed;'
  },
  {
    id: 'M05', file: 'server.js', expect: 'verify',
    note: '迁移不再幂等（重复迁移会重复建单元）',
    find: '      if (existing.has(t.lessonId)) return;',
    replace: '      if (false) return;'
  },
  {
    id: 'M06', file: 'server.js', expect: 'verify',
    note: '题数为 0 的提交不再被忽略',
    find: 'if (typeof b.quizScore === \'number\' && typeof b.quizTotal === \'number\' && b.quizTotal > 0) {',
    replace: 'if (typeof b.quizScore === \'number\') {'
  },
  {
    id: 'M07', file: 'server.js', expect: 'verify',
    note: '复测分数会冲掉历史最好成绩',
    find: '    // 复测只记进曲线，不冲高 quizBest（否则"记忆衰减"永远看不出来）',
    replace: '    t.quizBest = pct;'
  },
  {
    id: 'M08', file: 'css/app.css', expect: 'diag-note',
    note: '弹层层级掉到阅读器下面（点了没反应）',
    find: '.sheet-mask {\n  position: fixed; inset: 0; z-index: 55;',
    replace: '.sheet-mask {\n  position: fixed; inset: 0; z-index: 40;'
  },
  {
    id: 'M09', file: 'js/app.js', expect: 'diag-sheet',
    note: '弹层内部点击被误判成点外部（点哪都关）',
    find: '      if (sheet && sheet.contains(e.target)) {',
    replace: '      if (false) {'
  },
  {
    id: 'M10', file: 'js/app.js', expect: 'diag-review',
    note: '学完之后再答题不再记为复测',
    find: 'var wasDone = task.status === \'done\';',
    replace: 'var wasDone = false;'
  },
  {
    id: 'M11', file: 'js/app.js', expect: 'diag-next',
    note: '标记已读后底部不再出现「下一节」',
    find: '              (nextL\n                ? \'<button class="btn btn-primary wide" data-act="lesson-next"',
    replace: '              (false\n                ? \'<button class="btn btn-primary wide" data-act="lesson-next"'
  },
  {
    id: 'M12', file: 'README.md', expect: 'verify',
    note: '文档里的字数写错（不跟着实测走）',
    find: '4.2 万字符',
    replace: '8.4 万字符'
  }
];

/* ---------- 还原兜底 ---------- */
const backups = new Map();
function backup(file) {
  if (!backups.has(file)) backups.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
}
function restoreAll() {
  backups.forEach((content, file) => {
    try { fs.writeFileSync(path.join(ROOT, file), content, 'utf8'); } catch (e) { /* ignore */ }
  });
}
process.on('exit', restoreAll);
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(BASE + '/healthz').then((r) => (r.ok ? resolve() : retry())).catch(retry);
      function retry() {
        if (Date.now() > deadline) return reject(new Error('服务没起来'));
        setTimeout(poll, 200);
      }
    })();
  });
}

function runCheck(name) {
  const args = [path.join(__dirname, name + '.js')];
  if (name !== 'verify') args.push(BASE);
  try {
    execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 240000 });
    return { code: 0, out: '' };
  } catch (e) {
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    return { code: e.status == null ? 1 : e.status, out };
  }
}

(async function main() {
  const only = process.argv[2];
  const list = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
  if (!list.length) {
    console.log('没有这个变异编号：' + only);
    process.exit(1);
  }

  // 前端变异要真的跑浏览器，起一个临时服务（verify 自己会起，不冲突）
  const needServer = list.some((m) => m.expect !== 'verify');
  let child = null;
  if (needServer) {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
      stdio: 'ignore'
    });
    await waitHealth(15000);
    console.log('临时服务已起：' + BASE);
  }

  const rows = [];
  try {
    for (const m of list) {
      const abs = path.join(ROOT, m.file);
      backup(m.file);
      const original = backups.get(m.file);
      if (original.indexOf(m.find) < 0) {
        rows.push({ ...m, verdict: '变异无效', detail: '在 ' + m.file + ' 里找不到要替换的代码（代码改过就该更新这里）' });
        console.log('SKIP ' + m.id + ' 变异无效：找不到目标代码');
        continue;
      }
      fs.writeFileSync(abs, original.replace(m.find, m.replace), 'utf8');
      process.stdout.write('... ' + m.id + ' 跑 ' + m.expect + ' ');
      const res = runCheck(m.expect);
      fs.writeFileSync(abs, original, 'utf8');  // 立刻还原，别等下一轮
      const killed = res.code !== 0;
      rows.push({ ...m, verdict: killed ? '杀死' : '存活', detail: killed ? '被 ' + m.expect + ' 抓到' : '检查没管到这块' });
      console.log(killed ? '→ 杀死 ✔' : '→ 存活 ✘');
    }
  } finally {
    restoreAll();
    if (child) child.kill();
  }

  console.log('\n变异结果');
  console.log('---------------------------------------------');
  rows.forEach((r) => {
    console.log(' ' + r.id + '  ' + r.verdict + '  ' + r.note);
    if (r.verdict !== '杀死') console.log('        ' + r.detail);
  });
  const dead = rows.filter((r) => r.verdict === '存活').length;
  const invalid = rows.filter((r) => r.verdict === '变异无效').length;
  const killed = rows.filter((r) => r.verdict === '杀死').length;
  console.log('---------------------------------------------');
  console.log('杀死 ' + killed + ' / 存活 ' + dead + ' / 无效 ' + invalid + '（共 ' + rows.length + '）');
  if (dead > 0) console.log('\n有变异活下来了：说明这些错误整套自检都抓不到，得补检查。');
  if (invalid > 0) console.log('\n有变异无效：代码改了，mutate.js 里的 find 字符串要同步更新。');
  console.log(invalid === 0 && dead === 0 ? '\n全部杀死，自检有效。' : '\n需要处理。');
  process.exit(dead > 0 || invalid > 0 ? 1 : 0);
})();
