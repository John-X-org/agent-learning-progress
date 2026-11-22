/**
 * tools/probe-backup.js — 真实浏览器：导出备份 → 换账号 → 点「导入备份」把进度搬回来
 * 用法：node tools/probe-backup.js [BASE_URL]   默认 http://127.0.0.1:5391
 * 依赖：playwright-core + 系统 Edge（与 probe-flow.js 一致）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const BASE = (process.argv[2] || 'http://127.0.0.1:5391').replace(/\/$/, '');
const ts = String(Date.now()).slice(-6);
const lines = [];
function ok(name, cond, detail) {
  lines.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  → ' + detail : ''));
  console.log(lines[lines.length - 1]);
}

(async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  async function login(nick) {
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const nickInput = await page.$('#loginNick');
    if (!nickInput) { /* 已登录 */ return; }
    await page.fill('#loginNick', nick);
    await page.fill('#loginPin', '1234');
    await page.click('#btnLogin');
    await page.waitForTimeout(1300);
  }

  /* ---------- 账号甲：造一份有进度的数据 ---------- */
  await login('bk' + ts + 'a');
  const mig = await page.$('[data-act="migrate"]');
  if (mig) { await mig.click(); await page.waitForTimeout(1500); }

  await page.click('.tab[data-target="courses"]');
  await page.waitForTimeout(500);
  await page.click('#courseList [data-act="open-lesson"]');
  await page.waitForTimeout(700);
  const markBtn = await page.$('[data-act="mark-read"]:not([disabled])');
  if (markBtn) { await markBtn.click(); await page.waitForTimeout(800); }

  // 自测拿满分（走接口，避免依赖题目选项顺序），这样 L1 应被判为「学完」
  const full = await page.evaluate(async () => {
    const t = (await (await fetch('/api/tasks', { credentials: 'same-origin' })).json())
      .items.filter((x) => x.lessonId === 'L1')[0];
    const r = await fetch('/api/tasks/' + t.id + '/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ read: true, quizScore: 3, quizTotal: 3 })
    });
    return await r.json();
  });
  ok('甲账号第 1 节已判为学完', !!(full.item && full.item.status === 'done'), JSON.stringify(full.state || {}));

  // 写一条笔记（顺带回归上一轮修的弹层）
  await page.click('.reader-foot [data-act="lesson-note"]');
  await page.waitForTimeout(400);
  await page.fill('#fNoteTitle', '搬运测试笔记' + ts);
  await page.fill('#fNoteOld', '它解决的旧问题：历史要重发');
  await page.click('#btnSaveNote');
  await page.waitForTimeout(1300);
  await page.click('.reader-bar [data-act="close-reader"]');
  await page.waitForTimeout(500);

  // 打卡
  await page.click('.tab[data-target="dashboard"]');
  await page.waitForTimeout(400);
  await page.click('#btnCheckin');
  await page.waitForTimeout(400);
  await page.click('#btnSaveCheckin');
  await page.waitForTimeout(1000);

  // 导出到临时文件
  const dump = await page.evaluate(async () => {
    const r = await fetch('/api/export', { credentials: 'same-origin' });
    return await r.json();
  });
  const file = path.join(os.tmpdir(), 'alp-backup-' + ts + '.json');
  fs.writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
  ok('甲账号导出了备份文件', dump.tasks.length >= 13 && dump.notes.length === 1 && dump.checkins.length === 1,
    'tasks=' + dump.tasks.length + ' notes=' + dump.notes.length + ' checkins=' + dump.checkins.length);

  /* ---------- 账号乙：换账号后点「导入备份」 ---------- */
  await page.evaluate(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  });
  await login('bk' + ts + 'b');
  const mig2 = await page.$('[data-act="migrate"]');
  if (mig2) { await mig2.click(); await page.waitForTimeout(1500); }

  const beforeNotes = (await page.evaluate(async () => {
    const r = await fetch('/api/notes', { credentials: 'same-origin' });
    return (await r.json()).items.length;
  }));
  ok('乙账号导入前是空的', beforeNotes === 0, 'notes=' + beforeNotes);

  await page.click('.tab[data-target="review"]');
  await page.waitForTimeout(500);
  const btn = await page.$('[data-act="import-backup"]');
  ok('复盘页有「导入备份」按钮', !!btn);
  if (!btn) { await browser.close(); process.exit(1); }

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    btn.click()
  ]);
  ok('点按钮会弹出文件选择器', !!chooser);
  if (!chooser) { await browser.close(); process.exit(1); }
  await chooser.setFiles(file);
  await page.waitForTimeout(2000);

  const after = await page.evaluate(async () => {
    const g = async (p) => (await (await fetch(p, { credentials: 'same-origin' })).json());
    const t = await g('/api/tasks');
    const n = await g('/api/notes');
    const c = await g('/api/checkins');
    const l1 = t.items.filter((x) => x.lessonId === 'L1')[0];
    return {
      notes: n.items.length,
      checkins: c.items.length,
      l1Read: !!(l1 && l1.readAt),
      l1Done: !!(l1 && l1.status === 'done'),
      toast: (document.getElementById('toast') || {}).textContent || ''
    };
  });
  ok('导入后笔记到位', after.notes === 1, 'notes=' + after.notes);
  ok('导入后打卡到位', after.checkins === 1, 'checkins=' + after.checkins);
  ok('导入后第 1 节是已读状态', after.l1Read);
  ok('导入后第 1 节重新判为学完', after.l1Done);
  ok('导入后有明确提示', /已导入/.test(after.toast), after.toast);

  // 界面也要跟着变：笔记页能看到那条笔记
  await page.click('.tab[data-target="notes"]');
  await page.waitForTimeout(600);
  const noteVisible = await page.evaluate(() => {
    const box = document.getElementById('noteList');
    return box && box.textContent.indexOf('搬运测试笔记') >= 0;
  });
  ok('笔记页能看到导回来的笔记', noteVisible);

  if (errs.length) console.log('页面错误：' + errs.join(' | '));
  const pass = lines.every((l) => l.indexOf('PASS') === 0);
  console.log(pass ? '\n全部通过' : '\n有失败项');
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
