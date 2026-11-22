/**
 * tools/diag-review.js — 回归：复测记账、本机快照兜底、正文审校徽章
 * 用法：node tools/diag-review.js [BASE_URL]   默认 http://127.0.0.1:5391
 *
 * 覆盖：
 *  1) 阅读器显示「只过了机器检查」徽章，点开能看到待人工核对清单
 *  2) 学完的单元再答一遍 → 记为复测（toast 有复测 + 间隔天数），reviewCount 增加
 *  3) 本机自动留快照；换账号登录（服务端为空）时看板提示用快照恢复，恢复后进度回来
 */
'use strict';

const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const BASE = (process.argv[2] || 'http://127.0.0.1:5391').replace(/\/$/, '');
const ts = String(Date.now()).slice(-6);
let fails = 0;
function ok(name, cond, detail) {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  → ' + detail : ''));
}

const SNAP_PREFIX = 'alp:snap:v1:';

(async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });

  async function login(nick) {
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const input = await page.$('#loginNick');
    if (!input) return;
    await page.fill('#loginNick', nick);
    await page.fill('#loginPin', '1234');
    await page.click('#btnLogin');
    await page.waitForTimeout(1300);
  }

  async function importLessons() {
    const mig = await page.$('[data-act="migrate"]');
    if (mig) { await mig.click(); await page.waitForTimeout(1500); }
  }

  const toastText = () => page.evaluate(() => {
    const t = document.getElementById('toast');
    return t ? t.textContent : '';
  });

  /* ---------- A：审校徽章 + 复测 ---------- */
  await login('rv' + ts + 'a');
  await importLessons();

  // 用接口把 L1 打满分（省去猜答案），让它是「已学完」
  await page.evaluate(async () => {
    const items = (await (await fetch('/api/tasks', { credentials: 'same-origin' })).json()).items;
    const t = items.filter((x) => x.lessonId === 'L1')[0];
    await fetch('/api/tasks/' + t.id + '/progress', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: true, quizScore: 3, quizTotal: 3 })
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);

  await page.evaluate(() => { document.querySelector('.tab[data-target="courses"]').click(); });
  await page.waitForTimeout(500);
  await page.click('#courseList [data-act="open-lesson"]');
  await page.waitForTimeout(800);

  const badge = await page.evaluate(() => {
    const b = document.querySelector('.reader .review-badge');
    const d = document.querySelector('.reader .review-pending');
    return {
      exists: !!b,
      machine: !!(b && b.classList.contains('is-machine')),
      text: b ? b.textContent.trim() : '',
      pendingItems: d ? d.querySelectorAll('li').length : 0
    };
  });
  ok('阅读器显示审校徽章', badge.exists && badge.machine, badge.text.slice(0, 40));
  ok('徽章写明"事实还没人核对"', /没.*核对|待确认/.test(badge.text), badge.text.slice(0, 50));
  ok('能展开待人工核对清单（≥3 条）', badge.pendingItems >= 3, badge.pendingItems + ' 条');

  // 学完之后再答一遍 = 复测
  // 注意：每点一次选项 quizBox 就整体重绘，必须每轮重新查 DOM，不能拿一次性的 NodeList
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const total = document.querySelectorAll('#quizBox .quiz-q').length;
    for (let i = 0; i < total; i++) {
      const btn = document.querySelector('#quizBox [data-act="quiz-pick"][data-q="' + i + '"][data-o="0"]');
      if (btn) btn.click();
      await wait(120);
    }
  });
  await page.waitForTimeout(500);
  await page.click('#quizBox [data-act="quiz-submit"]');
  await page.waitForTimeout(1600);
  const t1 = await toastText();
  ok('学完后答题被记为复测', /复测/.test(t1), t1);

  const afterReview = await page.evaluate(async () => {
    const items = (await (await fetch('/api/tasks', { credentials: 'same-origin' })).json()).items;
    const t = items.filter((x) => x.lessonId === 'L1')[0];
    return { count: t.reviewCount, due: t.reviewDue, best: t.quizBest };
  });
  ok('复测次数记到 1', afterReview.count === 1, JSON.stringify(afterReview));
  ok('复测没把最好成绩冲掉（仍是 100）', afterReview.best === 100, 'best=' + afterReview.best);

  // 本机快照（复盘页能看到）
  await page.click('.reader-bar [data-act="close-reader"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelector('.tab[data-target="review"]').click(); });
  await page.waitForTimeout(600);
  const snapInfo = await page.evaluate((prefix) => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) keys.push(k);
    }
    const box = document.getElementById('accountBox');
    return { keys: keys.length, hasLine: box ? box.textContent.indexOf('本机快照') >= 0 : false };
  }, SNAP_PREFIX);
  ok('本机已留快照', snapInfo.keys >= 1, snapInfo.keys + ' 份');
  ok('复盘页显示本机快照状态', snapInfo.hasLine);

  /* ---------- B：换账号（服务端为空）→ 用快照恢复 ---------- */
  await ctx.clearCookies();
  await login('rv' + ts + 'b');
  await importLessons();
  await page.waitForTimeout(600);

  const restoreCard = await page.evaluate(() => {
    const rc = document.getElementById('reviewCard');
    return {
      text: rc ? rc.textContent : '',
      hasBtn: !!(rc && rc.querySelector('[data-act="local-restore"]'))
    };
  });
  ok('新账号看板提示「本机有进度快照」', /本机.*快照/.test(restoreCard.text) && restoreCard.hasBtn,
    restoreCard.text.slice(0, 40));

  await page.click('#reviewCard [data-act="local-restore"]');
  await page.waitForTimeout(1800);
  const t2 = await toastText();
  ok('一键恢复到当前账号', /已从本机快照恢复/.test(t2), t2);

  const restored = await page.evaluate(async () => {
    const items = (await (await fetch('/api/tasks', { credentials: 'same-origin' })).json()).items;
    const t = items.filter((x) => x.lessonId === 'L1')[0];
    return { read: !!(t && t.readAt), best: t ? t.quizBest : null, count: t ? t.reviewCount : null };
  });
  ok('恢复后已读回来了', restored.read);
  ok('恢复后成绩回来了', restored.best === 100, 'best=' + restored.best);
  ok('恢复后复测曲线也回来了', restored.count === 1, 'count=' + restored.count);
  ok('跨账号恢复时有确认提示', dialogs.length >= 1, dialogs.join(' / '));

  if (errs.length) console.log('页面错误：' + errs.join(' | '));
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n全部通过');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
