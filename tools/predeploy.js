/**
 * tools/predeploy.js — 发布前检查（防止把本地的开发数据传上去覆盖线上）
 * 用法：node tools/predeploy.js
 *
 * 背景：发布是把整个目录压缩上传，本地 data/ 里的 db.json 会被一起传上去，
 * 直接覆盖线上用户的真实进度。所以发布前 data/ 必须不存在（或为空库）。
 * 通过后返回 0，否则返回 1 并打印该怎么处理。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const failures = [];
const notes = [];

function line(s) { console.log(s); }

line('发布前检查：' + ROOT);

/* 1. data/ 目录必须不存在 */
if (fs.existsSync(DATA)) {
  const dbFile = path.join(DATA, 'db.json');
  let users = 0;
  if (fs.existsSync(dbFile)) {
    try {
      const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      users = (db.users || []).length;
    } catch (e) { users = -1; }
  }
  if (users !== 0) {
    failures.push('data/db.json 里有 ' + (users < 0 ? '（解析失败）' : users) + ' 个账号，上传会覆盖线上数据');
  } else {
    notes.push('data/ 存在但里面是空库，可以安全上传');
  }
  if (fs.existsSync(path.join(DATA, '.session_secret'))) {
    failures.push('data/.session_secret 存在：这是本地会话密钥，不该上传');
  }
} else {
  notes.push('data/ 不存在，上传包里没有本地数据（正确）');
}

/* 2. 必备文件在 */
['index.html', 'server.js', 'js/app.js', 'js/api.js', 'css/app.css'].forEach((f) => {
  if (!fs.existsSync(path.join(ROOT, f))) failures.push('缺文件：' + f);
});

/* 3. 语法自检 */
['server.js', 'js/app.js', 'js/api.js'].forEach((f) => {
  try {
    new Function(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (f === 'server.js') {
      try {
        require('child_process').execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
      } catch (err) {
        failures.push(f + ' 语法错误：' + err.message.split('\n')[0]);
      }
    } else {
      failures.push(f + ' 语法错误：' + e.message);
    }
  }
});

notes.forEach((n) => line('  说明  ' + n));
if (failures.length) {
  failures.forEach((f) => line('  FAIL  ' + f));
  line('\n不能发布。处理办法：');
  line('  1) 把 data/ 整个目录移到项目外面备份（例如 G:/workBuddyFile/学习/_deploy_data_backup_日期/）');
  line('  2) 删除项目内的 data/ 目录');
  line('  3) 再跑一次 node tools/predeploy.js');
  process.exit(1);
}
line('\n全部通过，可以发布。');
process.exit(0);
