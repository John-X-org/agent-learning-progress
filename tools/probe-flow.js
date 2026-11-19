/**
 * tools/probe-flow.js — 真实浏览器点击流探针（Playwright 驱动 Edge）
 * 覆盖：全新账号 → 看板「开始学这一节」→ 打开正确课程 → 返回；
 *       旧版无课程任务 → 迁移卡片 → 一键导入；
 *       完整学习环：标记已读 → 答题 → 提交 → 得分条。
 * 用法：node tools/probe-flow.js [BASE_URL]，默认 http://127.0.0.1:5173
 * 依赖：playwright-core（本机 ~/.workbuddy/binaries/node/workspace/node_modules）+ 系统 Edge
 */
'use strict';

const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '');
const ts = String(Date.now()).slice(-6);
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  → ' + detail : ''));
}

(async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  /* ---------- 场景 A：全新账号，看板按钮直达课程 ---------- */
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.fill('#loginNick', 'probeA' + ts);
  await page.fill('#loginPin', '1234');
  await page.click('#btnLogin');
  await page.waitForTimeout(1400);

  ok('A1 登录后进入应用', await page.evaluate(function () {
    const app = document.getElementById('appView');
    return !!app && !app.hidden;
  }));

  const btnId = await page.evaluate(function () {
    const b = document.querySelector('#nextCard [data-act="open-lesson"]');
    return b ? b.getAttribute('data-id') : null;
  });
  ok('A2 「开始学这一节」按钮带课程 id', btnId === 'L1', 'id=' + btnId);

  await page.click('#nextCard [data-act="open-lesson"]');
  await page.waitForTimeout(900);
  const reader = await page.evaluate(function () {
    const r = document.querySelector('.reader');
    if (!r) return { open: false };
    const t = r.querySelector('.reader-bar .rt b');
    return { open: true, title: t ? t.textContent : null, essence: !!r.querySelector('.essence') };
  });
  ok('A3 打开的是 L1 大模型基础认知',
    reader.open && reader.title === '大模型基础认知' && reader.essence, JSON.stringify(reader));

  await page.click('.reader-bar .back');
  await page.waitForTimeout(500);
  ok('A4 返回后阅读器关闭', await page.evaluate(function () {
    return !document.querySelector('.reader');
  }));

  /* ---------- 场景 B：旧版无课程任务（混合态）→ 清理入口 → 一键导入 ---------- */
  await page.evaluate(async function () {
    await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '旧版遗留任务', stage: 'filter' })
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);

  const migText = await page.evaluate(function () {
    const b = document.querySelector('#nextCard [data-act="migrate"]');
    return b ? b.textContent.trim() : null;
  });
  ok('B1 混合态：下一步卡片里出现旧任务清理入口', !!migText, 'text=' + migText);

  await page.click('#nextCard [data-act="migrate"]');
  await page.waitForTimeout(1800);
  const after = await page.evaluate(function () {
    const b = document.querySelector('#nextCard [data-act="open-lesson"]');
    return {
      openId: b ? b.getAttribute('data-id') : null,
      migrateGone: !document.querySelector('#nextCard [data-act="migrate"]')
    };
  });
  ok('B2 清理后下一步按钮保留且指向 L1',
    after.openId === 'L1' && after.migrateGone, JSON.stringify(after));

  const legacy = await page.evaluate(async function () {
    const r = await fetch('/api/dashboard');
    const j = await r.json();
    return j.legacyTasks;
  });
  ok('B3 服务端遗留任务计数归零', legacy === 0, 'legacy=' + legacy);

  /* ---------- 场景 D：纯旧版态（全部课程学完 + 遗留任务）→ 迁移卡片 ---------- */
  await page.evaluate(async function () {
    // 把 14 个课程任务全部标记完成，再造一条旧任务 → nextLesson 为空
    const r = await fetch('/api/tasks');
    const j = await r.json();
    for (const t of j.items) {
      await fetch('/api/tasks/' + t.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' })
      });
    }
    await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '纯旧版遗留任务', stage: 'apply' })
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);

  const dMig = await page.evaluate(function () {
    const b = document.querySelector('#nextCard [data-act="migrate"]');
    return b ? b.textContent.trim() : null;
  });
  ok('D1 纯旧版态：看板整卡变为「导入课程单元」', !!dMig, 'text=' + dMig);
  await page.click('#nextCard [data-act="migrate"]');
  await page.waitForTimeout(1800);
  const dAfter = await page.evaluate(function () {
    const b = document.querySelector('#nextCard [data-act="migrate"]');
    const all = document.querySelector('#nextCard .k');
    return {
      migrateGone: !b,
      allDoneShown: all ? all.textContent.indexOf('全部学完') >= 0 : false
    };
  });
  ok('D2 纯旧版态清理后显示「全部学完」',
    dAfter.migrateGone && dAfter.allDoneShown, JSON.stringify(dAfter));

  /* 把状态还原成可继续学习的（撤销全部完成，回到场景 C 用） */
  await page.evaluate(async function () {
    const r = await fetch('/api/tasks');
    const j = await r.json();
    for (const t of j.items) {
      await fetch('/api/tasks/' + t.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'todo' })
      });
    }
  });

  /* ---------- 场景 C：完整学习环 ---------- */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  await page.click('#nextCard [data-act="open-lesson"]');
  await page.waitForTimeout(900);
  await page.evaluate(function () {
    document.querySelector('.reader').scrollTop = 99999;
  });
  await page.waitForTimeout(400);

  const readBtn = await page.evaluate(function () {
    const b = document.querySelector('[data-act="mark-read"]');
    return b ? (b.disabled ? 'disabled' : 'enabled') : null;
  });
  ok('C1 底部「标记已读」可用', readBtn === 'enabled', 'state=' + readBtn);
  await page.click('[data-act="mark-read"]');
  await page.waitForTimeout(1400);

  const total = await page.evaluate(function () {
    return document.querySelectorAll('.quiz-q').length;
  });
  ok('C2 阅读器里有自测题', total >= 3, '题数=' + total);

  for (let i = 0; i < total; i++) {
    await page.evaluate(function (idx) {
      const q = document.querySelectorAll('.quiz-q')[idx];
      q.scrollIntoView({ block: 'center' });
      q.querySelector('.opt').click();
    }, i);
    await page.waitForTimeout(300);
  }
  await page.evaluate(function () {
    document.querySelector('[data-act="quiz-submit"]').scrollIntoView({ block: 'center' });
  });
  await page.click('[data-act="quiz-submit"]');
  await page.waitForTimeout(1800);

  const score = await page.evaluate(function () {
    const s = document.querySelector('#quizBox .score');
    return s ? s.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  ok('C3 提交后出现得分条', !!score, 'score=' + score);

  const fails = results.filter(function (r) { return !r.pass; });
  console.log(fails.length === 0
    ? 'ALL-PASS 共 ' + results.length + ' 项'
    : 'HAS-FAIL ' + fails.length + '/' + results.length);

  await browser.close();
  process.exitCode = fails.length === 0 ? 0 : 1;
})().catch(function (e) {
  console.error('探针异常：', e.message);
  process.exitCode = 1;
});
