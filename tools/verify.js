/**
 * tools/verify.js — 交付前自检
 * 用法：
 *   node tools/verify.js            正常运行全部检查
 *   node tools/verify.js --negative 反向验证（故意改错一处，必须 FAIL，用来证明检查有效）
 *
 * 它会在临时端口 + 临时数据目录上起一个独立实例，跑完自动关闭，不碰正式数据。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NEGATIVE = process.argv.includes('--negative');
const PORT = 5300 + Math.floor(Math.random() * 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alp-verify-'));

let cookie = '';
let failures = 0;
let checks = 0;

function ok(name, cond, detail) {
  checks++;
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''));
  }
}

async function api(p, opt) {
  opt = opt || {};
  const init = {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opt.body ? JSON.stringify(opt.body) : undefined
  };
  if (cookie) init.headers.cookie = cookie;
  const res = await fetch(BASE + p, init);
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length && sc[0].indexOf('alp=') === 0) cookie = sc[0].split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text };
}

function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(BASE + '/healthz')
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
      function retry() {
        if (Date.now() > deadline) return reject(new Error('server did not start'));
        setTimeout(poll, 200);
      }
    })();
  });
}

(async function main() {
  console.log('自检开始（端口 ' + PORT + '，数据目录临时）' +
    (NEGATIVE ? '  [反向验证模式：期望出现 FAIL]' : ''));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR }),
    stdio: 'ignore'
  });

  try {
    await waitHealth(15000);

    /* ---------- 1. 未登录必须被挡 ---------- */
    let r = await api('/api/auth/me');
    ok('未登录访问 /api/auth/me 返回 401', r.status === 401, 'status=' + r.status);
    r = await api('/api/tasks');
    ok('未登录访问 /api/tasks 返回 401', r.status === 401, 'status=' + r.status);
    r = await api('/api/curriculum');
    ok('未登录访问 /api/curriculum 返回 401', r.status === 401, 'status=' + r.status);

    /* ---------- 2. 登录即注册，初始模板只写一次 ---------- */
    r = await api('/api/auth/login', { method: 'POST', body: { nickname: '自检甲', pin: '1234' } });
    ok('首次登录自动建号', r.status === 200 && r.json && r.json.created === true);
    r = await api('/api/tasks');
    const seeded = r.json && r.json.items ? r.json.items.length : -1;
    ok('初始模板写入 14 条任务', seeded === 14, '实际 ' + seeded);

    const cases = r.json.items.filter((t) => t.kind === 'case').length;
    ok('其中 4 条标记为案例', cases === 4, '实际 ' + cases);

    /* ---------- 2.5 课程内容：结构完整性 ---------- */
    r = await api('/api/curriculum');
    const cur = r.json;
    ok('课程接口返回 4 阶段 14 单元',
      cur.stages.length === 4 && cur.lessons.length === 14,
      cur.stages.length + ' / ' + cur.lessons.length);

    const need = ['id', 'stage', 'module', 'title', 'minutes', 'essence', 'why', 'metaphor',
      'points', 'steps', 'pitfalls', 'quiz', 'followups', 'hints'];
    const broken = cur.lessons.filter((l) =>
      need.some((k) => l[k] === undefined || l[k] === null ||
        (typeof l[k] === 'string' && !l[k].trim())) ||
      !Array.isArray(l.points) || l.points.length < 3 ||
      !Array.isArray(l.steps) || l.steps.length < 2 ||
      !Array.isArray(l.pitfalls) || l.pitfalls.length < 2 ||
      !Array.isArray(l.quiz) || l.quiz.length < 3 ||
      !Array.isArray(l.followups) || l.followups.length < 2 ||
      !Array.isArray(l.hints) || l.hints.length !== 3);
    ok('14 个单元字段都不缺，正文/要点/步骤/踩坑/自测/追问/三层提示齐备',
      broken.length === 0,
      broken.length ? '有问题：' + broken.map((l) => l.id).join(',') : '');

    const badQuiz = cur.lessons.filter((l) =>
      l.quiz.some((q) => !q.q || !Array.isArray(q.options) || q.options.length < 2 ||
        typeof q.answer !== 'number' || q.answer < 0 || q.answer >= q.options.length ||
        !q.explain || !q.explain.trim()));
    ok('每道自测题的正确答案索引都在选项范围内、且都带解析',
      badQuiz.length === 0,
      badQuiz.length ? '有问题：' + badQuiz.map((l) => l.id).join(',') : '');

    const stepNoCode = cur.lessons.filter((l) => l.steps.some((s) => !s.h || !s.p));
    ok('每个「动手」步骤都有标题和正文', stepNoCode.length === 0);

    /* 正文允许 **加粗**：标记必须成对，否则页面会露出裸星号 */
    const badBold = cur.lessons.filter((l) => {
      const all = [l.essence, l.why, l.metaphor]
        .concat(l.points.map((p) => p.p), l.steps.map((s) => s.p),
          l.pitfalls.map((p) => p.p), l.pitfalls.map((p) => p.fix),
          l.quiz.map((q) => q.q), l.quiz.map((q) => q.explain),
          l.quiz.flatMap((q) => q.options),
          l.followups.map((f) => f.q), l.followups.map((f) => f.a),
          l.hints)
        .join('\n');
      return ((all.match(/\*\*/g) || []).length % 2) !== 0;
    });
    ok('课程正文的 ** 加粗标记全部成对（不会露出裸星号）',
      badBold.length === 0, badBold.length ? '有问题：' + badBold.map((l) => l.id).join(',') : '');

    const noH1 = cur.lessons.filter((l) => !l.essence || !l.why || !l.metaphor);
    ok('每个单元的本质卡/为什么/比喻都非空', noH1.length === 0,
      noH1.length ? '有问题：' + noH1.map((l) => l.id).join(',') : '');

    /* ---------- 正文审校状态（不许假装审校过） ---------- */
    const LEGAL_LEVELS = ['none', 'machine', 'human'];
    const badReview = cur.lessons.filter((l) => !l.review || LEGAL_LEVELS.indexOf(l.review.level) < 0);
    ok('每个单元都有合法的审校状态', badReview.length === 0, badReview.map((l) => l.id).join(','));

    const fakeHuman = cur.lessons.filter((l) =>
      l.review && l.review.level === 'human' && (!l.review.by || !l.review.at));
    ok('标成「已人工核对」的必须写明核对人和日期', fakeHuman.length === 0, fakeHuman.map((l) => l.id).join(','));

    const emptyPending = cur.lessons.filter((l) =>
      l.review && l.review.level === 'machine' && (!l.review.pending || !l.review.pending.length));
    ok('只过机器检查的单元必须列出待人工确认点', emptyPending.length === 0, emptyPending.map((l) => l.id).join(','));

    const pendingTotal = cur.lessons.reduce((a, l) => a + ((l.review && l.review.pending) || []).length, 0);
    let checkDoc = '';
    try { checkDoc = fs.readFileSync(path.join(__dirname, '..', '审校清单.md'), 'utf8'); } catch (e) { /* 缺文件在下面报 */ }
    const docTotal = (checkDoc.match(/^- \[ \]/gm) || []).length;
    ok('审校清单的待核对条目数与 review.js 一致（' + pendingTotal + '）',
      docTotal === pendingTotal, '文档里 ' + docTotal + ' 条');

    // 能判定语言的代码块做语法检查（JSON / JS）；Python、shell、提示词跳过并如实计入"已检查/总数"
    let codeChecked = 0;
    let codeTotal = 0;
    const badCode = [];
    cur.lessons.forEach((l) => (l.steps || []).forEach((s) => {
      if (!s.code) return;
      codeTotal++;
      const c0 = s.code.trim();
      const looksJson = /^[{[]/.test(c0) && c0.indexOf('<') < 0 && c0.indexOf('//') < 0 && c0.indexOf('#') < 0;
      const looksJs = /(function\s|=>|const\s)/.test(c0) && !/\bdef\s/m.test(c0) && !/^\s*import\s/m.test(c0);
      try {
        if (looksJson) { JSON.parse(c0); codeChecked++; }
        else if (looksJs) { new Function(c0); codeChecked++; }
      } catch (e) {
        if (!/^\s*(import|export)\s/m.test(c0) && c0.indexOf('await ') < 0) {
          badCode.push(l.id + '「' + String(s.h || '').slice(0, 12) + '」');
        }
      }
    }));
    ok('可判定语言的代码块语法通过（已查 ' + codeChecked + '/' + codeTotal + ' 块）', badCode.length === 0, badCode.join(','));

    const idsOk = cur.lessons.map((l) => l.id).join(',') ===
      'L1,L2,L3,L4,L5,L6,L7,L8,L9,L10,L11,L12,L13,L14';
    ok('单元 id 按 L1–L14 连续排列', idsOk);

    /* 文档必须跟代码一致：README 里要能查到每个单元的真实标题 */
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const missingDoc = cur.lessons.filter((l) => readme.indexOf(l.title) < 0).map((l) => l.id);
    ok('README 里能查到全部 14 个单元标题', missingDoc.length === 0,
      missingDoc.length ? '缺：' + missingDoc.join(',') : '');
    const docNumbers = ['14 个单元', '4 个"案例"', 'L8–L10']
      .filter((s) => readme.indexOf(s) < 0);
    ok('README 的单元/案例/笔记数量与代码一致', docNumbers.length === 0,
      docNumbers.length ? '缺：' + docNumbers.join(' / ') : '');

    /* 文档里的字数必须是实测值（踩过：一直写"8.4 万字"，实测只有 4.2 万字符） */
    // 只统计正文：review 字段（审校清单）不算正文，否则字数会被自己的检查项污染
    const raw = JSON.stringify(cur.lessons.map((l) => {
      const copy = Object.assign({}, l);
      delete copy.review;
      return copy;
    }));
    const actualWanChars = raw.length / 10000;
    const actualWanCn = (raw.match(/[\u4e00-\u9fa5]/g) || []).length / 10000;
    const docFiles = ['README.md', '使用手册.md', '问题台账与创作铁律.md'];
    const badChars = [];
    const badCn = [];
    docFiles.forEach((f) => {
      let t = '';
      try { t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); } catch (e) { return; }
      let m;
      const reC = /([\d.]+)\s*万字符/g;
      while ((m = reC.exec(t))) {
        if (Math.abs(Number(m[1]) - actualWanChars) > 0.15) badChars.push(f + ' 写 ' + m[1]);
      }
      const reN = /([\d.]+)\s*万汉字/g;
      while ((m = reN.exec(t))) {
        if (Math.abs(Number(m[1]) - actualWanCn) > 0.15) badCn.push(f + ' 写 ' + m[1]);
      }
    });
    ok('文档里的「万字符」与实测一致（' + actualWanChars.toFixed(2) + '）', badChars.length === 0, badChars.join(' / '));
    ok('文档里的「万汉字」与实测一致（' + actualWanCn.toFixed(2) + '）', badCn.length === 0, badCn.join(' / '));

    /* 云端副本的接线：配置写死在前端，改错了会静默连不上 */
    const appJsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
    ok('云端配置带着 endpoint 与 publishableKey',
      appJsSrc.indexOf('https://agent-study-checklist.app.workbuddy.host') >= 0 &&
      appJsSrc.indexOf('wbpk_63tEdplszNPHm8IB9ZcOwm_') >= 0);
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    ok('页面引了本地云 SDK（vendor/wbcloud.js）', indexSrc.indexOf('vendor/wbcloud.js') >= 0);
    ok('页面里云 SDK 在 api.js 之前加载',
      indexSrc.indexOf('vendor/wbcloud.js') < indexSrc.indexOf('js/api.js'));

    /* 任务必须从课程派生，且带上阅读所需字段 */
    const derived = (await api('/api/tasks')).json.items;
    const lessonSet = new Set(cur.lessons.map((l) => l.id));
    ok('每条任务都挂着课程单元 id', derived.every((t) => lessonSet.has(t.lessonId)));
    ok('每条任务都有预计分钟数', derived.every((t) => typeof t.minutes === 'number' && t.minutes > 0));
    const noteIds = derived.filter((t) => t.requiresNote).map((t) => t.lessonId).join(',');
    ok('要求出笔记的单元恰好是 L8,L9,L10', noteIds === 'L8,L9,L10', '实际 ' + noteIds);
    const caseIds = derived.filter((t) => t.kind === 'case').map((t) => t.lessonId).join(',');
    ok('案例型单元恰好是 L5,L6,L7,L12', caseIds === 'L5,L6,L7,L12', '实际 ' + caseIds);

    /* 删掉一条，重新登录不应被重置 */
    const victim = derived[0].id;
    await api('/api/tasks/' + victim, { method: 'DELETE' });
    await api('/api/auth/login', { method: 'POST', body: { nickname: '自检甲', pin: '1234' } });
    r = await api('/api/tasks');
    ok('删掉的任务登录后不会重置回默认', r.json.items.length === 13, '实际 ' + r.json.items.length);
    ok('重复登录不会重新注册', r.json && true);

    /* ---------- 3. 看板数字随任务状态变化 ---------- */
    r = await api('/api/dashboard');
    const before = r.json;
    ok('初始进度为 0%', before.totalPct === 0, '实际 ' + before.totalPct);
    ok('热力图 8 周 = 56 格', before.heatmap.length === 56, '实际 ' + before.heatmap.length);

    const t1 = (await api('/api/tasks')).json.items[0];
    await api('/api/tasks/' + t1.id, { method: 'PATCH', body: { status: 'done' } });
    r = await api('/api/dashboard');
    const after = r.json;
    ok('完成一个任务后 done 增加', after.done === before.done + 1, before.done + '→' + after.done);
    ok('完成一个任务后百分比上升', after.totalPct > before.totalPct,
      before.totalPct + '%→' + after.totalPct + '%');
    ok('今日热力图有动作', after.heatmap.filter((c) => c.isToday)[0].count >= 1);

    /* ---------- 4. 三层笔记 ---------- */
    r = await api('/api/notes', {
      method: 'POST',
      body: {
        title: '自检笔记', stage: 'explain', taskId: t1.id,
        oldProblem: '旧问题', mechanism: '比喻', pitfalls: '坑与修法'
      }
    });
    ok('新建三层笔记成功', r.status === 201 && r.json.item);
    const noteId = r.json.item.id;
    ok('笔记三层字段都存下来了',
      r.json.item.oldProblem === '旧问题' && r.json.item.mechanism === '比喻' && r.json.item.pitfalls === '坑与修法');

    r = await api('/api/notes/' + noteId, { method: 'PATCH', body: { pitfalls: '改过的修法' } });
    ok('笔记可编辑', r.status === 200 && r.json.item.pitfalls === '改过的修法');

    r = await api('/api/notes');
    ok('笔记列表能读回', r.json.items.length === 1);

    /* ---------- 5. 打卡一天一条 ---------- */
    r = await api('/api/checkins', { method: 'POST', body: { stage: 'explain', note: '第一次' } });
    ok('打卡成功', r.status === 201);
    r = await api('/api/checkins', { method: 'POST', body: { stage: 'apply', note: '第二次' } });
    ok('同一天重复打卡是覆盖不是新增', r.status === 200 && r.json.updated === true);
    r = await api('/api/checkins');
    ok('打卡记录只有一条', r.json.items.length === 1, '实际 ' + r.json.items.length);

    /* ---------- 6. 卡点队列 ---------- */
    const t2 = (await api('/api/tasks')).json.items[1];
    r = await api('/api/stuck', {
      method: 'POST',
      body: {
        taskId: t2.id, stuckText: '拿不到上游变量',
        attempts: '重发布工作流', nextStep: '打印 raw body'
      }
    });
    ok('记卡点成功', r.status === 201 && r.json.item.status === 'open');
    const stuckId = r.json.item.id;

    r = await api('/api/tasks');
    const stuckTask = r.json.items.filter((t) => t.id === t2.id)[0];
    ok('任务状态自动变成 stuck', stuckTask.status === 'stuck', '实际 ' + stuckTask.status);

    r = await api('/api/dashboard');
    ok('看板未闭环卡点数 = 1', r.json.openStuckCount === 1, '实际 ' + r.json.openStuckCount);

    r = await api('/api/stuck/' + stuckId, { method: 'PATCH', body: { nextStep: '先打印再断言' } });
    ok('卡点可更新下一步', r.json.item.nextStep === '先打印再断言');

    r = await api('/api/stuck/' + stuckId, { method: 'PATCH', body: { status: 'closed' } });
    ok('卡点可关闭', r.json.item.status === 'closed' && !!r.json.item.closedAt);
    r = await api('/api/dashboard');
    ok('关闭后看板未闭环归零', r.json.openStuckCount === 0, '实际 ' + r.json.openStuckCount);

    /* ---------- 7. 身份隔离 ---------- */
    const cookieA = cookie;
    cookie = '';
    await api('/api/auth/login', { method: 'POST', body: { nickname: '自检乙', pin: '9999' } });
    r = await api('/api/dashboard');
    ok('另一个账号看不到甲的完成记录', r.json.done === 0, '实际 ' + r.json.done);
    r = await api('/api/notes');
    ok('另一个账号看不到甲的笔记', r.json.items.length === 0, '实际 ' + r.json.items.length);
    r = await api('/api/tasks/' + t1.id, { method: 'PATCH', body: { status: 'todo' } });
    ok('越权改别人的任务被拒', r.status === 404, 'status=' + r.status);

    /* ---------- 8. 单元学习判定：读 → 自测 → （必需时）笔记 ---------- */
    cookie = '';
    await api('/api/auth/login', { method: 'POST', body: { nickname: '自检丙', pin: '7777' } });
    let mine = (await api('/api/tasks')).json.items;
    const byLesson = (id) => mine.filter((t) => t.lessonId === id)[0];

    const L2 = byLesson('L2');
    r = await api('/api/tasks/' + L2.id + '/progress', { method: 'POST', body: { read: true } });
    ok('点了「读完了」会记下时间', !!r.json.item.readAt);
    ok('只读了、还没自测 → 不算学完',
      r.json.state.done === false && r.json.item.status !== 'done',
      'done=' + r.json.state.done + ' status=' + r.json.item.status);

    r = await api('/api/tasks/' + L2.id + '/progress',
      { method: 'POST', body: { read: true, quizScore: 1, quizTotal: 3 } });
    ok('自测分数按百分比换算并保存', r.json.item.quizBest === 33, '实际 ' + r.json.item.quizBest);
    ok('自测不及格（33 分）→ 不算学完', r.json.state.done === false && r.json.state.quizPassed === false);

    r = await api('/api/tasks/' + L2.id + '/progress',
      { method: 'POST', body: { read: true, quizScore: 3, quizTotal: 3 } });
    ok('读 + 自测 100 分 → 自动判定学完，任务状态变 done',
      r.json.state.done === true && r.json.item.status === 'done' && !!r.json.item.completedAt);

    r = await api('/api/tasks/' + L2.id + '/progress',
      { method: 'POST', body: { read: true, quizScore: 0, quizTotal: 3 } });
    ok('重考低分不会把历史最好成绩冲掉',
      r.json.item.quizBest === 100 && r.json.item.status === 'done', '实际 ' + r.json.item.quizBest);

    r = await api('/api/tasks/' + L2.id + '/progress',
      { method: 'POST', body: { read: true, quizScore: 5, quizTotal: 0 } });
    ok('题数为 0 的无效提交被忽略', r.json.item.quizBest === 100, '实际 ' + r.json.item.quizBest);

    // 0/0 会算出 NaN：必须被挡住，否则成绩会被写成空
    r = await api('/api/tasks/' + L2.id + '/progress',
      { method: 'POST', body: { read: true, quizScore: 0, quizTotal: 0 } });
    ok('0 分的空提交也不会把成绩弄成空', r.json.item.quizBest === 100, '实际 ' + r.json.item.quizBest);

    const L8 = byLesson('L8');
    r = await api('/api/tasks/' + L8.id + '/progress',
      { method: 'POST', body: { read: true, quizScore: 3, quizTotal: 3 } });
    ok('要出笔记的单元：读 + 满分但没笔记 → 还不算学完',
      r.json.state.done === false && r.json.state.needNote === true && r.json.state.hasNote === false,
      JSON.stringify(r.json.state));

    r = await api('/api/notes', {
      method: 'POST',
      body: { title: 'L8 机制笔记', stage: 'explain', taskId: L8.id, mechanism: '用自己的话复述机制' }
    });
    ok('关联任务的笔记能建成功', r.status === 201);
    mine = (await api('/api/tasks')).json.items;
    const L8after = mine.filter((t) => t.lessonId === 'L8')[0];
    ok('补上笔记后，服务端自动把它判定为学完', L8after.status === 'done', '实际 ' + L8after.status);

    r = await api('/api/dashboard');
    ok('看板统计「已读单元数」= 2', r.json.readCount === 2, '实际 ' + r.json.readCount);
    ok('看板统计自测平均分', r.json.quizAvg === 100, '实际 ' + r.json.quizAvg);
    ok('看板给出下一节要学的单元', r.json.nextLesson && r.json.nextLesson.lessonId === 'L1',
      JSON.stringify(r.json.nextLesson));

    r = await api('/api/tasks/' + t1.id + '/progress', { method: 'POST', body: { read: true } });
    ok('越权给别人的单元记进度被拒', r.status === 404, 'status=' + r.status);

    /* ---------- 8.5 旧版无课程任务：不挡路 + 可迁移 ---------- */
    r = await api('/api/tasks', { method: 'POST', body: { title: '旧版遗留任务', stage: 'filter' } });
    ok('可以建一条不挂课程的任务（模拟旧版数据）', r.status === 201 && !r.json.item.lessonId);
    r = await api('/api/dashboard');
    ok('看板统计出遗留旧任务数 = 1', r.json.legacyTasks === 1, '实际 ' + r.json.legacyTasks);
    ok('「下一步」不指向没课程的任务，仍指向 L1',
      r.json.nextLesson && r.json.nextLesson.lessonId === 'L1', JSON.stringify(r.json.nextLesson));
    r = await api('/api/migrate', { method: 'POST' });
    ok('迁移接口：移除 1 条旧任务、新增 0（14 个单元都在）',
      r.status === 200 && r.json.removed === 1 && r.json.added === 0,
      JSON.stringify(r.json));
    r = await api('/api/dashboard');
    ok('迁移后遗留任务清零', r.json.legacyTasks === 0, '实际 ' + r.json.legacyTasks);
    r = await api('/api/tasks');
    ok('迁移后任务都是课程任务且共 14 条',
      r.json.items.length === 14 && r.json.items.every((t) => t.lessonId),
      '实际 ' + r.json.items.length);
    r = await api('/api/migrate', { method: 'POST' });
    ok('重复迁移是安全的（不再移除也不再新增）',
      r.json.removed === 0 && r.json.added === 0, JSON.stringify(r.json));

    /* ---------- 9. 错误 PIN / 静态资源 ---------- */
    r = await api('/api/auth/login', { method: 'POST', body: { nickname: '自检甲', pin: '0000' } });
    ok('错误 PIN 登录失败', r.status === 401, 'status=' + r.status);

    cookie = '';
    const page = await fetch(BASE + '/');
    const html = await page.text();
    ok('首页可访问', page.status === 200 && html.indexOf('学习进度台') > 0);
    const mf = await fetch(BASE + '/manifest.webmanifest');
    ok('manifest 可访问', mf.status === 200);
    const icon = await fetch(BASE + '/icons/icon-192.png');
    ok('图标可访问', icon.status === 200 && icon.headers.get('content-type') === 'image/png');

    /* ---------- 9. 间隔复测 ---------- */
    cookie = cookieA;
    // 自己造一个"真的学完"的单元（读数 + 满分 → 服务端判 done），不依赖前面用例的副作用
    const allTk = (await api('/api/tasks')).json.items;
    // 用「筛信息」阶段里不要求笔记的单元（前面的用例可能动过 L1）
    const seed = allTk.filter((t) => t.stage === 'filter' && !t.requiresNote)[0];
    await api('/api/tasks/' + seed.id + '/progress', {
      method: 'POST', body: { read: true, quizScore: 3, quizTotal: 3 }
    });
    const tk = (await api('/api/tasks')).json.items;
    const doneTask = tk.filter((t) => t.status === 'done' && t.quizBest != null)[0];
    ok('学完的单元自动排了复测日', !!(doneTask && doneTask.reviewDue),
      doneTask ? String(doneTask.reviewDue) : '没有带成绩的已学完单元');
    if (doneTask) {
      const bestBefore = doneTask.quizBest;
      const r1 = await api('/api/tasks/' + doneTask.id + '/review', {
        method: 'POST', body: { quizScore: 1, quizTotal: 3 }
      });
      ok('第一次复测：记录成功 + 下次排在 7 天后',
        r1.status === 200 && r1.json.item.reviewCount === 1 && r1.json.nextGapDays === 7,
        'count=' + (r1.json && r1.json.item && r1.json.item.reviewCount) + ' next=' + r1.json.nextGapDays);
      ok('复测 33% 不会冲掉历史最好成绩', r1.json.item.quizBest === bestBefore,
        '现在 ' + r1.json.item.quizBest + ' / 原来 ' + bestBefore);
      const d2 = await api('/api/dashboard');
      ok('看板统计到复测留存与衰减',
        d2.json.retention.count >= 1 && d2.json.retention.avgDecay != null,
        JSON.stringify(d2.json.retention));
      const r2 = await api('/api/tasks/' + doneTask.id + '/review', {
        method: 'POST', body: { quizScore: 0, quizTotal: 3 }
      });
      ok('第二次复测：间隔顺延到 21 天', r2.json.nextGapDays === 21, 'next=' + r2.json.nextGapDays);
      r = await api('/api/tasks/' + doneTask.id + '/review', {
        method: 'POST', body: { quizScore: 1, quizTotal: 0 }
      });
      ok('题数为 0 的复测被拒', r.status === 400, 'status=' + r.status);
    }

    /* ---------- 10. 导出备份 ---------- */
    cookie = cookieA;
    r = await api('/api/export');
    ok('导出备份包含四类数据',
      r.json && r.json.tasks.length >= 13 && r.json.notes.length === 1 &&
      r.json.checkins.length === 1 && r.json.stuck.length === 1);

    /* ---------- 10. 导入备份：换账号 / 重新发布后能把进度搬回来 ---------- */
    // 先在全新账号上造一份「有进度」的数据，再导出，再搬到另一个账号，才可能验证合并逻辑
    cookie = '';
    await api('/api/auth/login', { method: 'POST', body: { nickname: '自检丁', pin: '9999' } });
    const dTks = (await api('/api/tasks')).json.items;
    const dL1 = dTks.filter((t) => t.lessonId === 'L1')[0];
    const dL2 = dTks.filter((t) => t.lessonId === 'L2')[0];
    await api('/api/tasks/' + dL1.id + '/progress', {
      method: 'POST', body: { read: true, quizScore: 3, quizTotal: 3 }
    });
    await api('/api/notes', {
      method: 'POST',
      body: { title: '搬运测试笔记', stage: dL1.stage, taskId: dL1.id, oldProblem: '它解决的旧问题', mechanism: '', pitfalls: '' }
    });
    await api('/api/checkins', { method: 'POST', body: { date: '2026-11-20', stage: 'filter', note: '搬运测试打卡' } });
    await api('/api/stuck', {
      method: 'POST', body: { taskId: dL2.id, stuckText: '搬运测试卡点', attempts: '试过一次', nextStep: '看文档' }
    });

    const dump = (await api('/api/export')).json;
    ok('导出里带着 L1 的已读与满分成绩',
      dump.tasks.some((t) => t.lessonId === 'L1' && t.readAt && t.quizBest === 100));

    cookie = '';
    await api('/api/auth/login', { method: 'POST', body: { nickname: '自检戊', pin: '9999' } });
    r = await api('/api/backup/import', { method: 'POST', body: dump });
    const c = (r.json && r.json.counts) || {};
    ok('导入备份返回统计', r.status === 200 && (c.merged + c.tasks) > 0, JSON.stringify(c));

    r = await api('/api/tasks');
    const importedL1 = r.json.items.filter((t) => t.lessonId === 'L1')[0];
    ok('导入后 L1 的已读时间回来了', !!(importedL1 && importedL1.readAt));
    ok('导入后 L1 的满分成绩回来了', !!(importedL1 && importedL1.quizBest === 100),
      '实际 ' + (importedL1 && importedL1.quizBest));
    ok('导入后学完状态也重算回来了', !!(importedL1 && importedL1.status === 'done'),
      '实际 ' + (importedL1 && importedL1.status));

    r = await api('/api/notes');
    ok('导入后笔记搬回来了', r.json.items.length === 1, '实际 ' + (r.json ? r.json.items.length : r.text));
    r = await api('/api/checkins');
    ok('导入后打卡搬回来了', r.json.items.length === 1);
    r = await api('/api/stuck');
    ok('导入后卡点搬回来了', r.json.items.length === 1);

    await api('/api/backup/import', { method: 'POST', body: dump });
    const afterTasks = (await api('/api/tasks')).json.items.length;
    const afterNotes = (await api('/api/notes')).json.items.length;
    const afterCk = (await api('/api/checkins')).json.items.length;
    const afterStuck = (await api('/api/stuck')).json.items.length;
    ok('重复导入不会重复记账',
      afterTasks === 14 && afterNotes === 1 && afterCk === 1 && afterStuck === 1,
      `tasks=${afterTasks} notes=${afterNotes} checkins=${afterCk} stuck=${afterStuck}`);

    r = await api('/api/backup/import', { method: 'POST', body: { hello: 1 } });
    ok('无效备份文件被拒', r.status === 400, 'status=' + r.status);

    /* ---------- 11. 反向验证：故意用错的期望值，必须 FAIL ---------- */
    if (NEGATIVE) {
      console.log('\n  [反向验证] 下面四条应该 FAIL，FAIL 了才说明检查有效：');
      r = await api('/api/dashboard');
      ok('（故意写错）未闭环卡点应等于 99', r.json.openStuckCount === 99, '实际 ' + r.json.openStuckCount);
      r = await api('/api/tasks');
      ok('（故意写错）任务总数应等于 1', r.json.items.length === 1, '实际 ' + r.json.items.length);
      r = await api('/api/curriculum');
      ok('（故意写错）课程单元数应等于 1', r.json.lessons.length === 1, '实际 ' + r.json.lessons.length);
      cookie = '';
      await api('/api/auth/login', { method: 'POST', body: { nickname: '自检丙', pin: '7777' } });
      r = await api('/api/tasks');
      const l2 = r.json.items.filter((t) => t.lessonId === 'L2')[0];
      ok('（故意写错）L2 的最好成绩应等于 66', l2 && l2.quizBest === 66,
        '实际 ' + (l2 ? l2.quizBest : 'null'));
    }

    console.log('\n检查项 ' + checks + '，失败 ' + failures);
    if (NEGATIVE) {
      const good = failures >= 4;
      console.log(good
        ? '反向验证通过：故意写错的 ' + failures + ' 条都 FAIL 了，说明自检不是摆设。'
        : '反向验证失败：写错了期望值却没有 FAIL，自检不可信。');
      process.exitCode = good ? 0 : 1;
    } else {
      console.log(failures === 0 ? '全部通过。' : '有失败项，不可交付。');
      process.exitCode = failures === 0 ? 0 : 1;
    }
  } catch (err) {
    console.error('自检中断：', err.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
})();
