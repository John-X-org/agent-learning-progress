/**
 * tools/diag-note.js — 复现/回归：阅读器内点「写笔记」弹层是否真的可见可点
 * 用法：node tools/diag-note.js [BASE_URL]   默认 http://127.0.0.1:5391
 * 判定：点开写笔记后，弹层面板中心点的最顶层元素必须落在 .sheet 内部；
 *       若被 .reader 盖住（elementFromPoint 命中的是阅读器），视为 FAIL。
 */
'use strict';

const { chromium } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const BASE = (process.argv[2] || 'http://127.0.0.1:5391').replace(/\/$/, '');
const ts = String(Date.now()).slice(-6);

(async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.fill('#loginNick', 'diag' + ts);
  await page.fill('#loginPin', '1234');
  await page.click('#btnLogin');
  await page.waitForTimeout(1200);

  // 先导入 14 个课程单元（全新账号需要）
  const migrateBtn = await page.$('[data-act="migrate"]');
  if (migrateBtn) {
    await migrateBtn.click();
    await page.waitForTimeout(1500);
  }

  // 打开课程页第一节课
  await page.click('.tab[data-target="courses"]');
  await page.waitForTimeout(600);
  await page.click('#courseList [data-act="open-lesson"]');
  await page.waitForTimeout(700);

  const opened = await page.evaluate(() => {
    const r = document.querySelector('.reader');
    return r ? (r.querySelector('.rt b') || {}).textContent : null;
  });
  console.log('打开课程：' + (opened || '(失败)'));

  // 标记已读
  const markBtn = await page.$('[data-act="mark-read"]:not([disabled])');
  if (markBtn) { await markBtn.click(); await page.waitForTimeout(900); }

  // 自测：每题选第一个选项，然后提交
  await page.evaluate(() => {
    const seen = {};
    document.querySelectorAll('#quizBox [data-act="quiz-pick"][data-o="0"]').forEach(b => {
      const q = b.getAttribute('data-q');
      if (!seen[q]) { seen[q] = 1; b.click(); }
    });
  });
  await page.waitForTimeout(400);
  const submitBtn = await page.$('#quizBox [data-act="quiz-submit"]');
  if (submitBtn) { await submitBtn.click(); await page.waitForTimeout(1200); }

  // 点「写笔记」
  const noteBtn = await page.$('.reader-foot [data-act="lesson-note"]');
  if (!noteBtn) { console.log('FAIL 找不到写笔记按钮'); await browser.close(); process.exit(1); }
  await noteBtn.click();
  await page.waitForTimeout(600);

  const r = await page.evaluate(() => {
    const mask = document.querySelector('.sheet-mask');
    const sheet = document.querySelector('.sheet');
    if (!mask || !sheet) return { exists: false };
    const b = sheet.getBoundingClientRect();
    const cx = Math.round(b.left + b.width / 2);
    const cy = Math.round(b.top + Math.min(80, b.height / 2));
    const top = document.elementFromPoint(cx, cy);
    const maskZ = getComputedStyle(mask).zIndex;
    const reader = document.querySelector('.reader');
    const readerZ = reader ? getComputedStyle(reader).zIndex : null;
    return {
      exists: true,
      maskZ: maskZ,
      readerZ: readerZ,
      hitInsideSheet: !!(top && top.closest('.sheet')),
      hitTag: top ? (top.tagName + '.' + (top.className || '')) : null,
      title: (sheet.querySelector('h2') || {}).textContent || '',
      rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]
    };
  });

  console.log(JSON.stringify(r, null, 2));
  const pass1 = r.exists && r.hitInsideSheet;
  console.log((pass1 ? 'PASS' : 'FAIL') + ' 写笔记弹层可见可点');

  /* ---------- 第二段：真的能填能存，且存完阅读器里出现「有笔记」 ---------- */
  let pass2 = false, pass3 = false;
  if (pass1) {
    await page.fill('#fNoteTitle', '诊断笔记' + ts);
    await page.fill('#fNoteOld', '以前以为它记住了，其实每轮都得重发历史');
    await page.fill('#fNoteMech', '像记事本：历史↔本子；每轮↔抄一遍');
    await page.click('#btnSaveNote');
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => {
      const mask = document.querySelector('.sheet-mask');
      const chips = Array.prototype.map.call(document.querySelectorAll('.reader .req .item2'),
        c => ({ t: (c.textContent || '').trim(), ok: c.classList.contains('ok') }));
      return { sheetGone: !mask, chips: chips };
    });
    pass2 = after.sheetGone;
    console.log((pass2 ? 'PASS' : 'FAIL') + ' 保存后弹层关闭');
    pass3 = after.chips.some(c => /笔记/.test(c.t) && c.ok);
    console.log((pass3 ? 'PASS' : 'FAIL') + ' 阅读器笔记标记变 ✓  → ' +
      after.chips.map(c => (c.ok ? '✓' : '○') + c.t).join(' / '));

    // 卡住按钮同样走弹层，一并回归
    const stuckBtn = await page.$('.reader-foot [data-act="lesson-stuck"]');
    if (stuckBtn) {
      await stuckBtn.click();
      await page.waitForTimeout(500);
      const stuckOk = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet');
        if (!sheet) return false;
        const b = sheet.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + 60));
        return !!(top && top.closest('.sheet'));
      });
      console.log((stuckOk ? 'PASS' : 'FAIL') + ' 卡住弹层可见可点');
    }
  }

  if (errs.length) console.log('页面错误：' + errs.join(' | '));

  const pass = pass1 && pass2 && pass3;
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
