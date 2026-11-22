/**
 * tools/diag-next.js — 回归：学完一节能直接进下一节，不用先返回课程列表
 * 用法：node tools/diag-next.js [BASE_URL]   默认 http://127.0.0.1:5391
 *
 * 覆盖：
 *  1) 未读时底部是「标记已读」，没有「下一节」
 *  2) 正文末尾始终有「下一节：XXX ›」，点它能进入下一节（标题/hash/滚动位置都要对）
 *  3) 标记已读后底部按钮换成「下一节 ›」
 *  4) 走到 L14 时变成「回课程列表」，点了能回到课程页
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

  const state = () => page.evaluate(() => {
    const t = document.querySelector('.reader-bar .rt b');
    const foot = document.querySelector('.reader-foot');
    const end = document.querySelector('.reader-end');
    const btn = end ? end.querySelector('[data-act]') : null;
    const feetActs = foot ? Array.prototype.map.call(foot.querySelectorAll('[data-act]'), (b) => b.getAttribute('data-act')) : [];
    return {
      title: t ? t.textContent : null,
      hash: location.hash,
      footActs: feetActs,
      endText: btn ? btn.textContent.trim() : null,
      endDone: end ? (end.querySelector('.end-done') || {}).textContent || '' : '',
      endPending: end ? (end.querySelector('.end-pending') || {}).textContent || '' : '',
      scrollTop: (document.getElementById('reader') || {}).scrollTop
    };
  });

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.fill('#loginNick', 'nx' + ts);
  await page.fill('#loginPin', '1234');
  await page.click('#btnLogin');
  await page.waitForTimeout(1200);
  const mig = await page.$('[data-act="migrate"]');
  if (mig) { await mig.click(); await page.waitForTimeout(1500); }

  // 打开 L1
  await page.evaluate(() => {
    const u = document.querySelector('#courseList [data-act="open-lesson"]');
    if (u) u.click();
  });
  await page.waitForTimeout(800);
  let s = await state();
  ok('打开第 1 节', s.title === '大模型基础认知', s.title);

  const ov = await page.evaluate(() => {
    const btn = document.querySelector('.reader-end .btn');
    return {
      docSw: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      btnSw: btn ? btn.scrollWidth : null,
      btnCw: btn ? btn.clientWidth : null
    };
  });
  ok('末尾按钮在窄屏不横向溢出',
    ov.btnSw != null && ov.btnSw <= ov.btnCw + 1 && ov.docSw <= ov.vw + 1, JSON.stringify(ov));
  ok('未读时底部是「标记已读」、没有「下一节」',
    s.footActs.indexOf('mark-read') >= 0 && s.footActs.indexOf('lesson-next') < 0, s.footActs.join(','));

  // 末尾必须始终有进入下一节的入口
  ok('正文末尾有「下一节」入口', !!(s.endText && s.endText.indexOf('下一节') === 0), s.endText);
  ok('未学完时末尾提示还差什么', /还差/.test(s.endPending), s.endPending);

  // 往下滚，点末尾的下一节
  await page.evaluate(() => {
    const el = document.getElementById('reader');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  await page.click('.reader-end [data-act="lesson-next"]');
  await page.waitForTimeout(600);
  s = await state();
  ok('点末尾「下一节」进入 L2', s.title === '提示词工程', s.title);
  ok('地址栏跟着变', s.hash === '#lesson/L2', s.hash);
  ok('切节后回到顶部', s.scrollTop === 0, 'scrollTop=' + s.scrollTop);

  // 标记已读 → 底部换成「下一节 ›」
  await page.click('.reader-foot [data-act="mark-read"]');
  await page.waitForTimeout(1100);
  s = await state();
  ok('标记已读后底部出现「下一节 ›」',
    s.footActs.indexOf('lesson-next') >= 0 && s.footActs.indexOf('mark-read') < 0, s.footActs.join(','));

  // 底部按钮连续往下走，直到最后一节
  for (let i = 0; i < 12; i++) {
    const btn = await page.$('.reader-foot [data-act="lesson-next"]');
    if (!btn) break;
    await btn.click();
    await page.waitForTimeout(450);
    const mk = await page.$('.reader-foot [data-act="mark-read"]');
    if (mk) { await mk.click(); await page.waitForTimeout(700); }
  }
  s = await state();
  ok('一路走到最后一节 L14', s.hash === '#lesson/L14', s.hash + ' / ' + s.title);
  ok('最后一节底部换成「回课程列表」', s.footActs.indexOf('go-courses') >= 0, s.footActs.join(','));
  ok('最后一节末尾也说明是最后一节', !!s.endText && s.endText.indexOf('最后一节') >= 0, s.endText);

  // 回课程列表
  await page.click('.reader-foot [data-act="go-courses"]');
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({
    readerGone: !document.querySelector('.reader'),
    coursesShown: !document.querySelector('.view[data-view="courses"]').hidden
  }));
  ok('点「回课程列表」能回到课程页', back.readerGone && back.coursesShown, JSON.stringify(back));

  if (errs.length) console.log('页面错误：' + errs.join(' | '));
  console.log(fails ? '\n有 ' + fails + ' 项失败' : '\n全部通过');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
