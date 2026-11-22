/**
 * tools/diag-sheet.js — 回归：弹层里点内部任意位置不能被关掉，只有点遮罩空白或 ✕/取消 才关
 * 用法：node tools/diag-sheet.js [BASE_URL]   默认 http://127.0.0.1:5391
 *
 * 起因：打卡弹层"点哪都关"——遮罩自身带 data-close，closest() 从内部元素一路冒泡命中它，
 *      导致点输入框、下拉、标题、空白全被当成"点了关闭"。
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

(async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  // 点一下但不等太久：元素不在了就跳过，让下面的断言统一报错，而不是整支脚本崩掉
  async function tap(sel, opts) {
    try {
      await page.locator(sel).first().click(Object.assign({ timeout: 2500 }, opts || {}));
    } catch (e) { /* 弹层可能已被关掉 */ }
  }

  const sheetOpen = () => page.evaluate(() => !!document.querySelector('.sheet-mask'));
  const sheetTitle = () => page.evaluate(() => {
    const h = document.querySelector('.sheet h2');
    return h ? h.textContent : null;
  });

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.fill('#loginNick', 'sh' + ts);
  await page.fill('#loginPin', '1234');
  await page.click('#btnLogin');
  await page.waitForTimeout(1200);

  /* ---------- 打卡弹层 ---------- */
  await page.click('#btnCheckin');
  await page.waitForTimeout(400);
  ok('打卡弹层打开', (await sheetOpen()) && (await sheetTitle()) === '今日打卡', await sheetTitle());

  await tap('.sheet h2');
  await page.waitForTimeout(200);
  ok('点弹层标题不会关', await sheetOpen());

  await tap('.sheet-hint');
  await page.waitForTimeout(200);
  ok('点提示文字不会关', await sheetOpen());

  await tap('.sheet-body', { position: { x: 6, y: 6 } });
  await page.waitForTimeout(200);
  ok('点弹层内空白不会关', await sheetOpen());

  await tap('#fCkNote');
  await page.waitForTimeout(200);
  ok('点一句话输入框不会关', await sheetOpen());
  try { await page.type('#fCkNote', '测试输入'); } catch (e) { /* 弹层被关了 */ }
  await page.waitForTimeout(200);
  const ckVal = await page.evaluate(() => { const el = document.getElementById('fCkNote'); return el ? el.value : ''; });
  ok('能在输入框里正常打字', await sheetOpen() && ckVal === '测试输入', ckVal || '(输入框已不在)');

  await page.evaluate(() => { document.getElementById('fCkStage').click(); });
  await page.waitForTimeout(200);
  ok('点下拉框不会关', await sheetOpen());

  // 取消按钮（弹层内 data-close）应该能关
  await tap('.sheet-actions [data-close]');
  await page.waitForTimeout(300);
  ok('点「取消」能关', !(await sheetOpen()));

  // 遮罩空白应能关
  await page.click('#btnCheckin');
  await page.waitForTimeout(400);
  ok('再次打开打卡弹层', await sheetOpen());
  await page.mouse.click(195, 30);
  await page.waitForTimeout(300);
  ok('点遮罩空白能关', !(await sheetOpen()));

  /* ---------- 写笔记弹层（同一个 openSheet，一起回归） ---------- */
  await page.evaluate(() => { document.querySelector('.tab[data-target="dashboard"]').click(); });
  await page.waitForTimeout(300);
  const mig = await page.$('[data-act="migrate"]');
  if (mig) { await mig.click(); await page.waitForTimeout(1500); }

  await page.evaluate(() => { document.querySelector('.tab[data-target="courses"]').click(); });
  await page.waitForTimeout(500);
  await page.click('#courseList [data-act="open-lesson"]');
  await page.waitForTimeout(700);
  await page.click('.reader-foot [data-act="lesson-note"]');
  await page.waitForTimeout(500);
  ok('写笔记弹层打开', (await sheetOpen()) && (await sheetTitle()) === '写一条三层笔记', await sheetTitle());

  await tap('#fNoteTitle');
  await page.waitForTimeout(200);
  ok('点标题框不会关', await sheetOpen());
  try { await page.type('#fNoteTitle', '点内部不关'); } catch (e) { /* 弹层被关了 */ }
  await page.waitForTimeout(200);
  const titleVal = await page.evaluate(() => { const el = document.getElementById('fNoteTitle'); return el ? el.value : ''; });
  ok('能在标题框里接着打字', await sheetOpen() && titleVal.indexOf('点内部不关') >= 0, titleVal || '(输入框已不在)');

  await tap('#fNoteMech');
  await page.waitForTimeout(200);
  ok('点正文文本域不会关', await sheetOpen());

  await tap('.sheet .field-label');
  await page.waitForTimeout(200);
  ok('点字段标签不会关', await sheetOpen());

  await tap('.sheet-head .icon-btn');
  await page.waitForTimeout(300);
  ok('点 ✕ 能关', !(await sheetOpen()));

  if (errs.length) console.log('页面错误：' + errs.join(' | '));
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n全部通过');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
