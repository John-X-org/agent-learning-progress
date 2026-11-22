/**
 * server.js — AI 智能体学习进度台 后端
 * 零第三方依赖：node 内置 http / crypto / fs。
 * 接口按模块拆分：/api/tasks /api/notes /api/checkins /api/stuck /api/dashboard /api/auth
 * 数据落盘：<DATA_DIR>/db.json（原子写），并保留 snapshot 备份。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const SECRET = process.env.SESSION_SECRET || loadOrCreateSecret();
const SESSION_DAYS = 60;

/* ============================ 存储 ============================ */

function loadOrCreateSecret() {
  const f = path.join(DATA_DIR, '.session_secret');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s) return s;
  } catch (e) { /* 首次启动 */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(f, s, { mode: 0o600 });
  } catch (e) { /* 只读环境下降级为进程内密钥 */ }
  return s;
}

const EMPTY_DB = { seq: 1, users: [], tasks: [], notes: [], checkins: [], stuck: [] };

let db = null;
let writing = Promise.resolve();

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = Object.assign({}, EMPTY_DB, parsed);
    ['users', 'tasks', 'notes', 'checkins', 'stuck'].forEach((k) => {
      if (!Array.isArray(db[k])) db[k] = [];
    });
  } catch (e) {
    db = JSON.parse(JSON.stringify(EMPTY_DB));
  }
}

function nextId() {
  db.seq = (db.seq || 1) + 1;
  return db.seq;
}

function persist() {
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
      await fsp.rename(tmp, DB_FILE);
    } catch (err) {
      console.error('[db] persist failed:', err.message);
    }
  });
  return writing;
}

function snapshot() {
  // 每天第一次写入留一份快照，防止误删可回滚
  const day = new Date().toISOString().slice(0, 10);
  const f = path.join(SNAP_DIR, 'db-' + day + '.json');
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  if (!fs.existsSync(f)) {
    try { fs.writeFileSync(f, JSON.stringify(db), 'utf8'); } catch (e) { /* ignore */ }
  }
}

/* ============================ 预置任务模板（来自课程内容） ============================ */

const CONTENT = require('./content');
const LESSONS = CONTENT.lessons;
const LESSON_BY_ID = CONTENT.byId;

// 任务模板不再手写：直接由课程单元派生，保证"任务是内容长出来的"
const DEFAULT_TASKS = LESSONS.map((l) => ({
  stage: l.stage,
  module: l.module,
  title: l.title,
  kind: CONTENT.CASE_IDS.indexOf(l.id) >= 0 ? 'case' : 'task',
  lessonId: l.id
}));

const STAGES = CONTENT.STAGES;

const STAGE_NAME = {};
STAGES.forEach((s) => { STAGE_NAME[s.key] = s.name; });

// 间隔复习的间隔（天）：学完 → 3 天 → 7 天 → 21 天 → 之后一直 60 天
const REVIEW_GAPS = [3, 7, 21, 60];

/* ============================ 工具 ============================ */

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function dateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function todayStr() { return dateStr(new Date()); }

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function dayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : dateStr(d);
}

function daysBetween(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/* ============================ 会话 ============================ */

function signSession(userId) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = b64url(JSON.stringify({ u: userId, e: exp }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return payload + '.' + sig;
}

function verifySession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  if (sig !== expect) return null;
  try {
    const obj = JSON.parse(unb64url(payload).toString('utf8'));
    if (!obj || !obj.u || obj.e < Date.now()) return null;
    return obj.u;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const uid = verifySession(parseCookies(req).alp);
  if (!uid) return null;
  return db.users.find((u) => u.id === uid) || null;
}

function publicUser(u) {
  return { id: u.id, nickname: u.nickname, createdAt: u.createdAt };
}

/* ============================ HTTP 工具 ============================ */

function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'Service-Worker-Allowed': '/'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ============================ 登录限流 ============================ */

const attempts = new Map(); // nickname -> {count, resetAt}

function tooManyAttempts(nick) {
  const rec = attempts.get(nick);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { attempts.delete(nick); return false; }
  return rec.count >= 8;
}

function noteAttempt(nick, ok) {
  const rec = attempts.get(nick) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  rec.count = ok ? 0 : rec.count + 1;
  rec.resetAt = ok ? 0 : rec.resetAt;
  attempts.set(nick, rec);
}

/* ============================ 业务：用户 ============================ */

function ownedTasks(userId) { return db.tasks.filter((t) => t.userId === userId); }
function ownedNotes(userId) { return db.notes.filter((n) => n.userId === userId); }
function ownedCheckins(userId) { return db.checkins.filter((c) => c.userId === userId); }
function ownedStuck(userId) { return db.stuck.filter((s) => s.userId === userId); }

function createUser(nickname, pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    id: 'u' + crypto.randomBytes(8).toString('hex'),
    nickname: nickname,
    salt: salt,
    pinHash: hashPin(pin, salt),
    seeded: false,
    createdAt: new Date().toISOString()
  };
  db.users.push(u);
  seedTasks(u.id);
  u.seeded = true;
  snapshot();
  persist();
  return u;
}

function seedTasks(userId) {
  DEFAULT_TASKS.forEach((t, i) => {
    db.tasks.push({
      id: nextId(),
      userId: userId,
      lessonId: t.lessonId,
      stage: t.stage,
      module: t.module,
      title: t.title,
      kind: t.kind,
      status: 'todo',
      sortOrder: i,
      readAt: null,
      quizBest: null,
      quizTotal: null,
      reviewDue: null,
      reviewLog: [],
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });
}

/* ============================ 业务：看板计算 ============================ */

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const w = (x.getDay() + 6) % 7;
  return addDays(x, -w);
}

function levelOf(n) {
  if (!n) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n <= 4) return 3;
  return 4;
}

function buildActivity(tasks, notes, checkins) {
  const map = {};
  const bump = (day) => { if (day) map[day] = (map[day] || 0) + 1; };
  checkins.forEach((c) => bump(c.checkinDate));
  notes.forEach((n) => bump(dayOf(n.createdAt)));
  tasks.forEach((t) => { if (t.status === 'done') bump(dayOf(t.completedAt)); });
  return map;
}

function buildHeatmap(activity, weeks) {
  const todayDate = new Date();
  const start = mondayOf(addDays(todayDate, -(weeks - 1) * 7));
  const cells = [];
  const tS = dateStr(todayDate);
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const key = dateStr(d);
    const n = activity[key] || 0;
    cells.push({ date: key, count: n, level: levelOf(n), isToday: key === tS, future: d > todayDate });
  }
  return cells;
}

function weekStats(tasks, notes, checkins, weekStart) {
  const from = dateStr(weekStart);
  const to = dateStr(addDays(weekStart, 6));
  const byStage = {};
  STAGES.forEach((s) => { byStage[s.key] = { checkins: 0, notes: 0, done: 0 }; });
  const inRange = (day) => day && day >= from && day <= to;

  checkins.forEach((c) => {
    if (inRange(c.checkinDate) && byStage[c.stage]) byStage[c.stage].checkins++;
  });
  notes.forEach((n) => {
    if (inRange(dayOf(n.createdAt)) && byStage[n.stage]) byStage[n.stage].notes++;
  });
  tasks.forEach((t) => {
    if (t.status === 'done' && inRange(dayOf(t.completedAt)) && byStage[t.stage]) byStage[t.stage].done++;
  });

  let total = 0;
  let top = null;
  STAGES.forEach((s) => {
    const v = byStage[s.key].checkins + byStage[s.key].notes + byStage[s.key].done;
    total += v;
    if (!top || v > top.value) top = { key: s.key, name: s.name, value: v };
  });
  return { from, to, total, byStage, top };
}

function buildReview(tasks, notes, checkins, stuck, weekStart) {
  const act = weekStats(tasks, notes, checkins, weekStart);
  const taskById = {};
  tasks.forEach((t) => { taskById[t.id] = t; });

  const endOfWeek = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7).getTime();
  const openStucks = stuck.filter((s) => {
    const entered = new Date(s.enteredAt).getTime();
    if (entered > endOfWeek) return false;
    if (s.status === 'open') return true;
    return s.closedAt ? new Date(s.closedAt).getTime() > endOfWeek : false;
  });

  let stuckTitle = '（没有未闭环的卡点）';
  if (openStucks.length) {
    const t = taskById[openStucks[0].taskId];
    stuckTitle = t ? t.title : String(openStucks[0].stuckText || '').slice(0, 18);
  }

  const noteCount = notes.filter((n) => {
    const d = dayOf(n.createdAt);
    return d && d >= act.from && d <= act.to;
  }).length;

  const explainTasks = tasks.filter((t) => t.stage === 'explain');
  const explainDone = explainTasks.filter((t) => t.status === 'done').length;
  const applyDone = tasks.filter((t) => t.stage === 'apply' && t.status === 'done').length;

  let next = '用出来';
  let reason = '保持推进最小链路';
  if (noteCount === 0 && explainDone < explainTasks.length) {
    next = '讲清楚';
    reason = '本周没有产出三层笔记';
  } else if (applyDone === 0) {
    next = '用出来';
    reason = '笔记有了但没有跑通的最小链路';
  } else if (openStucks.length > 0 && act.top && (act.top.key === 'filter' || act.top.key === 'decompose')) {
    next = '用出来';
    reason = '前半程投入偏多，卡点还挂着';
  }

  let sentence;
  if (act.total === 0) {
    const first = tasks[0] ? tasks[0].title : '打开任务列表';
    sentence = '这一周没有任何学习动作记录。下周挑一个最小任务（哪怕只是「' + first + '」）先动起来，优先回到「' + next + '」。';
  } else {
    const topName = act.top && act.top.value > 0 ? act.top.name : '（分散）';
    sentence = '本周你的投入最多在「' + topName + '」（' + act.total + ' 个有效动作），' +
      (openStucks.length ? '卡点「' + stuckTitle + '」还没闭环；' : '没有挂着没处理的卡点；') +
      '下周优先回到「' + next + '」——' + reason + '。';
  }

  return {
    weekStart: act.from,
    weekEnd: act.to,
    total: act.total,
    byStage: act.byStage,
    topStage: act.top ? act.top.name : null,
    noteCount,
    openStucks: openStucks.length,
    stuckTitle,
    nextStage: next,
    sentence
  };
}

function buildDashboard(userId) {
  const tasks = ownedTasks(userId);
  const notes = ownedNotes(userId);
  const checkins = ownedCheckins(userId);
  const stuck = ownedStuck(userId);

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const cases = tasks.filter((t) => t.kind === 'case');
  const casesDone = cases.filter((t) => t.status === 'done').length;

  const stages = STAGES.map((s) => {
    const list = tasks.filter((t) => t.stage === s.key);
    const d = list.filter((t) => t.status === 'done').length;
    return { key: s.key, name: s.name, total: list.length, done: d, pct: list.length ? Math.round((d / list.length) * 100) : 0 };
  });

  const activity = buildActivity(tasks, notes, checkins);
  const heatmap = buildHeatmap(activity, 8);

  const openStuck = stuck.filter((s) => s.status === 'open');
  const overdue = openStuck.filter((s) => daysBetween(s.enteredAt) > 2);

  const thisMonday = mondayOf(new Date());
  const reviews = [0, 1, 2, 3].map((i) =>
    buildReview(tasks, notes, checkins, stuck, addDays(thisMonday, -7 * i))
  );

  const today = todayStr();
  const todayCheckin = checkins.find((c) => c.checkinDate === today) || null;

  const ordered = tasks.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id));
  // 旧版账号可能有"没有挂课程单元"的任务：它们不该出现在「下一步」里，只能走迁移
  const legacyTasks = ordered.filter((t) => !t.lessonId).length;
  const next = ordered.filter((t) => t.status !== 'done' && t.lessonId)[0] || null;

  const scored = tasks.filter((t) => t.quizBest != null);
  const quizAvg = scored.length
    ? Math.round(scored.reduce((a, t) => a + t.quizBest, 0) / scored.length)
    : null;

  // 到期该回测的单元（学完 + 排了复测日 + 已到期）
  const nowMs = Date.now();
  const dueReviews = ordered
    .filter((t) => t.lessonId && t.status === 'done' && t.reviewDue && new Date(t.reviewDue).getTime() <= nowMs)
    .sort((a, b) => new Date(a.reviewDue) - new Date(b.reviewDue))
    .slice(0, 3)
    .map((t) => ({
      lessonId: t.lessonId,
      title: t.title,
      dueAt: t.reviewDue,
      overdueDays: Math.max(0, Math.floor((nowMs - new Date(t.reviewDue).getTime()) / 86400000)),
      firstPct: t.quizBest,
      lastPct: Array.isArray(t.reviewLog) && t.reviewLog.length ? t.reviewLog[t.reviewLog.length - 1].pct : null
    }));

  // 记忆留存：只统计"学过 + 至少回测过一次"的单元，看出还记得多少
  const reviewed = tasks.filter((t) => Array.isArray(t.reviewLog) && t.reviewLog.length && t.quizBest != null);
  const retention = {
    count: reviewed.length,
    decays: reviewed.map((t) => t.reviewLog[t.reviewLog.length - 1].pct - t.quizBest),
    avgDecay: reviewed.length
      ? Math.round(reviewed.reduce((a, t) => a + (t.reviewLog[t.reviewLog.length - 1].pct - t.quizBest), 0) / reviewed.length)
      : null
  };

  return {
    total,
    done,
    totalPct: total ? Math.round((done / total) * 100) : 0,
    cases: { planned: cases.length, done: casesDone },
    stages,
    heatmap,
    openStuckCount: openStuck.length,
    overdueStuckCount: overdue.length,
    reviews,
    activityTotal: Object.keys(activity).reduce((a, k) => a + activity[k], 0),
    todayCheckin,
    readCount: tasks.filter((t) => t.readAt).length,
    quizAvg,
    notesCount: notes.length,
    legacyTasks,
    dueReviews,
    retention,
    nextLesson: next ? {
      id: next.id,
      lessonId: next.lessonId || null,
      title: next.title,
      stage: next.stage,
      stageName: STAGE_NAME[next.stage] || next.stage,
      read: !!next.readAt
    } : null
  };
}

/* ============================ 单元完成判定 ============================ */

/**
 * 一个单元算"学完"的条件：读过 + 自测 ≥80 分 + （要求出笔记的单元）已有笔记。
 * 判定只在服务端做，前端只负责展示缺哪一项。
 */
function recheckLessonDone(userId, t) {
  const lesson = t.lessonId ? LESSON_BY_ID[t.lessonId] : null;
  const needNote = !!(lesson && lesson.requiresNote);
  const hasNote = db.notes.some((n) => n.userId === userId && n.taskId === t.id);
  const quizPassed = t.quizBest != null && t.quizBest >= 80;
  const read = !!t.readAt;
  const done = read && quizPassed && (!needNote || hasNote);

  if (done && t.status !== 'done') {
    t.status = 'done';
    t.completedAt = new Date().toISOString();
  }
  // 学完就排第一次回测（3 天后）；老数据缺这个字段的，这里补上
  if (done && !t.reviewDue) {
    t.reviewDue = addDays(new Date(), REVIEW_GAPS[0]).toISOString();
  }
  return { read: read, quizPassed: quizPassed, needNote: needNote, hasNote: hasNote, done: done };
}

/* ============================ 序列化（camelCase → 前端字段） ============================ */

function taskOut(t) {
  const lesson = t.lessonId ? LESSON_BY_ID[t.lessonId] : null;
  return {
    id: t.id, lessonId: t.lessonId || null, stage: t.stage, module: t.module,
    title: t.title, kind: t.kind, status: t.status, sortOrder: t.sortOrder,
    readAt: t.readAt || null,
    quizBest: t.quizBest == null ? null : t.quizBest,
    quizTotal: t.quizTotal == null ? null : t.quizTotal,
    reviewDue: t.reviewDue || null,
    reviewCount: Array.isArray(t.reviewLog) ? t.reviewLog.length : 0,
    reviewLog: Array.isArray(t.reviewLog) ? t.reviewLog.slice(-20) : [],
    reviewLast: Array.isArray(t.reviewLog) && t.reviewLog.length
      ? t.reviewLog[t.reviewLog.length - 1] : null,
    requiresNote: !!(lesson && lesson.requiresNote),
    minutes: lesson ? lesson.minutes : null,
    completedAt: t.completedAt, createdAt: t.createdAt, updatedAt: t.updatedAt
  };
}

function noteOut(n) {
  return {
    id: n.id, taskId: n.taskId, stage: n.stage, module: n.module, title: n.title,
    oldProblem: n.oldProblem, mechanism: n.mechanism, pitfalls: n.pitfalls,
    createdAt: n.createdAt, updatedAt: n.updatedAt
  };
}

function checkinOut(c) {
  return { id: c.id, checkinDate: c.checkinDate, stage: c.stage, note: c.note, createdAt: c.createdAt };
}

function stuckOut(s) {
  return {
    id: s.id, taskId: s.taskId, stuckText: s.stuckText, attempts: s.attempts,
    nextStep: s.nextStep, status: s.status, enteredAt: s.enteredAt, closedAt: s.closedAt,
    days: daysBetween(s.enteredAt)
  };
}

/* ============================ 路由 ============================ */

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();
  const user = currentUser(req);

  /* ---------- auth ---------- */
  if (pathname === '/api/auth/me' && method === 'GET') {
    if (!user) return sendJson(res, 401, { error: '未登录' });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const nickname = String(body.nickname || '').trim();
    const pin = String(body.pin || '').trim();

    if (nickname.length < 1 || nickname.length > 20) {
      return sendJson(res, 400, { error: '昵称长度请控制在 1–20 个字' });
    }
    if (!/^\d{4}$/.test(pin)) {
      return sendJson(res, 400, { error: 'PIN 必须是 4 位数字' });
    }
    if (tooManyAttempts(nickname)) {
      return sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });
    }

    let u = db.users.find((x) => x.nickname === nickname);
    let created = false;
    if (!u) {
      u = createUser(nickname, pin);
      created = true;
    } else if (hashPin(pin, u.salt) !== u.pinHash) {
      noteAttempt(nickname, false);
      return sendJson(res, 401, { error: '昵称或 PIN 不对' });
    }
    noteAttempt(nickname, true);

    const token = signSession(u.id);
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
    const cookie = 'alp=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
      (SESSION_DAYS * 86400) + (secure ? '; Secure' : '');
    return sendJson(res, 200, { user: publicUser(u), created }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': 'alp=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    });
  }

  /* ---------- 以下全部需要登录 ---------- */
  if (!user) return sendJson(res, 401, { error: '未登录' });

  if (pathname === '/api/user' && method === 'PATCH') {
    const body = await readBody(req);
    const nickname = String(body.nickname || '').trim();
    if (nickname.length < 1 || nickname.length > 20) {
      return sendJson(res, 400, { error: '昵称长度请控制在 1–20 个字' });
    }
    const taken = db.users.find((x) => x.nickname === nickname && x.id !== user.id);
    if (taken) return sendJson(res, 409, { error: '这个昵称已经被占用' });
    user.nickname = nickname;
    persist();
    return sendJson(res, 200, { user: publicUser(user), saved: true });
  }

  /* ---------- 课程内容 ---------- */
  if (pathname === '/api/curriculum' && method === 'GET') {
    return sendJson(res, 200, { stages: STAGES, lessons: LESSONS });
  }

  /* ---------- tasks ---------- */
  if (pathname === '/api/tasks') {
    if (method === 'GET') {
      const items = ownedTasks(user.id)
        .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id))
        .map(taskOut);
      return sendJson(res, 200, { items });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.title || !String(b.title).trim()) return sendJson(res, 400, { error: '标题不能为空' });
      if (!STAGE_NAME[b.stage]) return sendJson(res, 400, { error: '阶段不合法' });
      const now = new Date().toISOString();
      const t = {
        id: nextId(), userId: user.id, stage: b.stage,
        module: b.module ? String(b.module).trim() : null,
        title: String(b.title).trim(),
        kind: b.kind === 'case' ? 'case' : 'task',
        status: 'todo',
        sortOrder: ownedTasks(user.id).length,
        completedAt: null, createdAt: now, updatedAt: now
      };
      db.tasks.push(t);
      persist();
      return sendJson(res, 201, { item: taskOut(t), saved: true });
    }
  }

  /* ---------- 单元学习进度：已读 / 自测 ---------- */
  const pm = pathname.match(/^\/api\/tasks\/(\d+)\/progress$/);
  if (pm && method === 'POST') {
    const t = db.tasks.find((x) => x.id === Number(pm[1]) && x.userId === user.id);
    if (!t) return sendJson(res, 404, { error: '任务不存在' });
    const b = await readBody(req);

    if (b.read === true && !t.readAt) {
      t.readAt = new Date().toISOString();
      if (t.status === 'todo') t.status = 'doing';
    }
    if (b.read === false) t.readAt = null;

    if (typeof b.quizScore === 'number' && typeof b.quizTotal === 'number' && b.quizTotal > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((b.quizScore / b.quizTotal) * 100)));
      t.quizBest = t.quizBest == null ? pct : Math.max(t.quizBest, pct);
      t.quizTotal = b.quizTotal;
    }

    const state = recheckLessonDone(user.id, t);
    t.updatedAt = new Date().toISOString();
    persist();
    return sendJson(res, 200, { item: taskOut(t), saved: true, state });
  }

  /* ---------- 间隔复测：记录一次回测成绩，并排下一次 ---------- */
  const rm = pathname.match(/^\/api\/tasks\/(\d+)\/review$/);
  if (rm && method === 'POST') {
    const t = db.tasks.find((x) => x.id === Number(rm[1]) && x.userId === user.id);
    if (!t) return sendJson(res, 404, { error: '任务不存在' });
    const b = await readBody(req);
    const total = Number(b.quizTotal);
    const score = Number(b.quizScore);
    if (!(total > 0) || !(score >= 0)) return sendJson(res, 400, { error: '题目数量不合法' });
    const pct = Math.max(0, Math.min(100, Math.round((score / total) * 100)));
    const now = new Date().toISOString();
    t.reviewLog = Array.isArray(t.reviewLog) ? t.reviewLog : [];
    t.reviewLog.push({ at: now, pct: pct, score: score, total: total });
    if (t.reviewLog.length > 20) t.reviewLog = t.reviewLog.slice(-20);
    // 复测只记进曲线，不冲高 quizBest（否则"记忆衰减"永远看不出来）
    const gap = REVIEW_GAPS[Math.min(t.reviewLog.length, REVIEW_GAPS.length - 1)];
    t.reviewDue = addDays(new Date(), gap).toISOString();
    t.updatedAt = now;
    persist();
    return sendJson(res, 200, { item: taskOut(t), saved: true, nextGapDays: gap });
  }

  let m = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (m) {
    const t = db.tasks.find((x) => x.id === Number(m[1]) && x.userId === user.id);
    if (!t) return sendJson(res, 404, { error: '任务不存在' });
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (b.title !== undefined) {
        if (!String(b.title).trim()) return sendJson(res, 400, { error: '标题不能为空' });
        t.title = String(b.title).trim();
      }
      if (b.stage !== undefined) {
        if (!STAGE_NAME[b.stage]) return sendJson(res, 400, { error: '阶段不合法' });
        t.stage = b.stage;
      }
      if (b.module !== undefined) t.module = b.module ? String(b.module).trim() : null;
      if (b.kind !== undefined) t.kind = b.kind === 'case' ? 'case' : 'task';
      if (b.status !== undefined) {
        if (!['todo', 'doing', 'done', 'stuck'].includes(b.status)) {
          return sendJson(res, 400, { error: '状态不合法' });
        }
        t.status = b.status;
        if (b.status === 'done' && !t.completedAt) t.completedAt = new Date().toISOString();
        if (b.status === 'done' && !t.reviewDue) {
          t.reviewDue = addDays(new Date(), REVIEW_GAPS[0]).toISOString();
        }
        if (b.status !== 'done') t.completedAt = null;
      }
      t.updatedAt = new Date().toISOString();
      persist();
      return sendJson(res, 200, { item: taskOut(t), saved: true });
    }
    if (method === 'DELETE') {
      db.tasks = db.tasks.filter((x) => x.id !== t.id);
      db.notes.forEach((n) => { if (n.taskId === t.id) n.taskId = null; });
      db.stuck = db.stuck.filter((s) => s.taskId !== t.id);
      persist();
      return sendJson(res, 200, { ok: true, saved: true });
    }
  }

  /* ---------- 旧版数据迁移：去掉无课程任务，补齐课程单元任务 ---------- */
  if (pathname === '/api/migrate' && method === 'POST') {
    const owned = ownedTasks(user.id);
    const removed = owned.filter((t) => !t.lessonId).length;
    db.tasks = db.tasks.filter((x) => !(x.userId === user.id && !x.lessonId));

    const now = new Date().toISOString();
    const existing = new Set(db.tasks.filter((t) => t.userId === user.id).map((t) => t.lessonId));
    let added = 0;
    DEFAULT_TASKS.forEach((t, i) => {
      if (existing.has(t.lessonId)) return;
      db.tasks.push({
        id: nextId(), userId: user.id, lessonId: t.lessonId,
        stage: t.stage, module: t.module, title: t.title, kind: t.kind,
        status: 'todo', sortOrder: i,
        readAt: null, quizBest: null, quizTotal: null,
        reviewDue: null, reviewLog: [],
        completedAt: null, createdAt: now, updatedAt: now
      });
      added++;
    });

    // 按课程顺序重排 sortOrder，保证「下一步」指到第一节没学的
    const idx = {};
    DEFAULT_TASKS.forEach((t, i) => { idx[t.lessonId] = i; });
    db.tasks.forEach((x) => {
      if (x.userId === user.id && x.lessonId && idx[x.lessonId] != null) x.sortOrder = idx[x.lessonId];
    });

    persist();
    return sendJson(res, 200, { removed, added, saved: true });
  }

  /* ---------- notes ---------- */
  if (pathname === '/api/notes') {
    if (method === 'GET') {
      const items = ownedNotes(user.id)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(noteOut);
      return sendJson(res, 200, { items });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.title || !String(b.title).trim()) return sendJson(res, 400, { error: '标题不能为空' });
      if (!STAGE_NAME[b.stage]) return sendJson(res, 400, { error: '阶段不合法' });
      const now = new Date().toISOString();
      const n = {
        id: nextId(), userId: user.id,
        taskId: b.taskId ? Number(b.taskId) : null,
        stage: b.stage,
        module: b.module ? String(b.module).trim() : null,
        title: String(b.title).trim(),
        oldProblem: String(b.oldProblem || ''),
        mechanism: String(b.mechanism || ''),
        pitfalls: String(b.pitfalls || ''),
        createdAt: now, updatedAt: now
      };
      db.notes.push(n);
      if (n.taskId) {
        const linked = db.tasks.find((x) => x.id === n.taskId && x.userId === user.id);
        if (linked) recheckLessonDone(user.id, linked);
      }
      persist();
      return sendJson(res, 201, { item: noteOut(n), saved: true });
    }
  }

  m = pathname.match(/^\/api\/notes\/(\d+)$/);
  if (m) {
    const n = db.notes.find((x) => x.id === Number(m[1]) && x.userId === user.id);
    if (!n) return sendJson(res, 404, { error: '笔记不存在' });
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (b.title !== undefined) {
        if (!String(b.title).trim()) return sendJson(res, 400, { error: '标题不能为空' });
        n.title = String(b.title).trim();
      }
      if (b.stage !== undefined) {
        if (!STAGE_NAME[b.stage]) return sendJson(res, 400, { error: '阶段不合法' });
        n.stage = b.stage;
      }
      if (b.taskId !== undefined) n.taskId = b.taskId ? Number(b.taskId) : null;
      if (b.module !== undefined) n.module = b.module ? String(b.module).trim() : null;
      if (b.oldProblem !== undefined) n.oldProblem = String(b.oldProblem);
      if (b.mechanism !== undefined) n.mechanism = String(b.mechanism);
      if (b.pitfalls !== undefined) n.pitfalls = String(b.pitfalls);
      n.updatedAt = new Date().toISOString();
      persist();
      return sendJson(res, 200, { item: noteOut(n), saved: true });
    }
    if (method === 'DELETE') {
      db.notes = db.notes.filter((x) => x.id !== n.id);
      persist();
      return sendJson(res, 200, { ok: true, saved: true });
    }
  }

  /* ---------- checkins ---------- */
  if (pathname === '/api/checkins') {
    if (method === 'GET') {
      const items = ownedCheckins(user.id)
        .sort((a, b) => (a.checkinDate < b.checkinDate ? -1 : 1))
        .map(checkinOut);
      return sendJson(res, 200, { items });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : todayStr();
      const stage = STAGE_NAME[b.stage] ? b.stage : null;
      const note = b.note ? String(b.note).slice(0, 200) : null;
      const existing = db.checkins.find((c) => c.userId === user.id && c.checkinDate === day);
      if (existing) {
        existing.stage = stage;
        existing.note = note;
        persist();
        return sendJson(res, 200, { item: checkinOut(existing), saved: true, updated: true });
      }
      const c = {
        id: nextId(), userId: user.id, checkinDate: day,
        stage, note, createdAt: new Date().toISOString()
      };
      db.checkins.push(c);
      persist();
      return sendJson(res, 201, { item: checkinOut(c), saved: true });
    }
  }

  /* ---------- stuck queue ---------- */
  if (pathname === '/api/stuck') {
    if (method === 'GET') {
      const items = ownedStuck(user.id)
        .sort((a, b) => new Date(b.enteredAt) - new Date(a.enteredAt))
        .map(stuckOut);
      return sendJson(res, 200, { items });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.stuckText || !String(b.stuckText).trim()) {
        return sendJson(res, 400, { error: '卡点原文不能为空' });
      }
      const task = b.taskId ? db.tasks.find((t) => t.id === Number(b.taskId) && t.userId === user.id) : null;
      if (!task) return sendJson(res, 400, { error: '任务不存在' });
      const s = {
        id: nextId(), userId: user.id, taskId: task.id,
        stuckText: String(b.stuckText).trim(),
        attempts: String(b.attempts || ''),
        nextStep: String(b.nextStep || ''),
        status: 'open',
        enteredAt: new Date().toISOString(),
        closedAt: null
      };
      db.stuck.push(s);
      task.status = 'stuck';
      task.updatedAt = s.enteredAt;
      persist();
      return sendJson(res, 201, { item: stuckOut(s), saved: true });
    }
  }

  m = pathname.match(/^\/api\/stuck\/(\d+)$/);
  if (m) {
    const s = db.stuck.find((x) => x.id === Number(m[1]) && x.userId === user.id);
    if (!s) return sendJson(res, 404, { error: '卡点不存在' });
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (b.stuckText !== undefined) s.stuckText = String(b.stuckText);
      if (b.attempts !== undefined) s.attempts = String(b.attempts);
      if (b.nextStep !== undefined) s.nextStep = String(b.nextStep);
      if (b.status !== undefined) {
        if (!['open', 'closed'].includes(b.status)) return sendJson(res, 400, { error: '状态不合法' });
        s.status = b.status;
        s.closedAt = b.status === 'closed' ? new Date().toISOString() : null;
      }
      persist();
      return sendJson(res, 200, { item: stuckOut(s), saved: true });
    }
    if (method === 'DELETE') {
      db.stuck = db.stuck.filter((x) => x.id !== s.id);
      persist();
      return sendJson(res, 200, { ok: true, saved: true });
    }
  }

  /* ---------- dashboard ---------- */
  if (pathname === '/api/dashboard' && method === 'GET') {
    return sendJson(res, 200, buildDashboard(user.id));
  }

  /* ---------- 备份导入：重新发布后把进度搬回来 ---------- */
  if (pathname === '/api/backup/import' && method === 'POST') {
    const body = await readBody(req);
    const srcTasks = Array.isArray(body.tasks) ? body.tasks : [];
    const srcNotes = Array.isArray(body.notes) ? body.notes : [];
    const srcCheckins = Array.isArray(body.checkins) ? body.checkins : [];
    const srcStuck = Array.isArray(body.stuck) ? body.stuck : [];
    if (!srcTasks.length && !srcNotes.length && !srcCheckins.length && !srcStuck.length) {
      return sendJson(res, 400, { error: '这不是本应用的备份文件（没有 tasks/notes/checkins/stuck 数据）' });
    }

    const now = new Date().toISOString();
    const counts = { tasks: 0, merged: 0, notes: 0, checkins: 0, stuck: 0, skipped: 0 };
    const mine = ownedTasks(user.id);
    const byLesson = new Map();
    mine.forEach((t) => { if (t.lessonId) byLesson.set(t.lessonId, t); });
    const idMap = new Map(); // 备份里的任务 id → 当前账号下的任务 id

    // 1) 任务：按 lessonId 合并（进度只进不退），缺失的补建
    srcTasks.forEach((src) => {
      const lesson = src.lessonId ? LESSON_BY_ID[src.lessonId] : null;
      if (!lesson) { counts.skipped++; return; }
      let t = byLesson.get(lesson.id);
      if (t) {
        if (src.readAt && !t.readAt) t.readAt = src.readAt;
        if (typeof src.quizBest === 'number' && (t.quizBest == null || src.quizBest > t.quizBest)) {
          t.quizBest = src.quizBest;
          if (typeof src.quizTotal === 'number') t.quizTotal = src.quizTotal;
        }
        // 复测曲线也搬回来（按「时间 + 分数」去重，重复导入不会翻倍）
        if (Array.isArray(src.reviewLog) && src.reviewLog.length) {
          t.reviewLog = Array.isArray(t.reviewLog) ? t.reviewLog : [];
          const seenLog = new Set(t.reviewLog.map((r) => String(r.at) + '|' + r.pct));
          src.reviewLog.forEach((r) => {
            const k = String(r.at) + '|' + r.pct;
            if (!seenLog.has(k)) { t.reviewLog.push(r); seenLog.add(k); }
          });
          t.reviewLog.sort((a, b) => new Date(a.at) - new Date(b.at));
        }
        if (src.reviewDue && !t.reviewDue) t.reviewDue = src.reviewDue;
        t.updatedAt = now;
        counts.merged++;
      } else {
        t = {
          id: nextId(), userId: user.id, lessonId: lesson.id,
          stage: lesson.stage, module: lesson.module, title: lesson.title,
          kind: CONTENT.CASE_IDS.indexOf(lesson.id) >= 0 ? 'case' : 'task',
          status: 'todo', sortOrder: mine.length + counts.tasks,
          readAt: src.readAt || null,
          quizBest: typeof src.quizBest === 'number' ? src.quizBest : null,
          quizTotal: typeof src.quizTotal === 'number' ? src.quizTotal : null,
          reviewDue: src.reviewDue || null,
          reviewLog: Array.isArray(src.reviewLog) ? src.reviewLog.slice(-20) : [],
          completedAt: null, createdAt: src.createdAt || now, updatedAt: now
        };
        db.tasks.push(t);
        byLesson.set(lesson.id, t);
        counts.tasks++;
      }
      if (src.id != null) idMap.set(String(src.id), t.id);
    });

    // 2) 笔记（标题 + 关联单元去重，taskId 重映射）
    const noteKeys = new Set(ownedNotes(user.id).map((n) => n.title + '\u0000' + (n.taskId == null ? '' : n.taskId)));
    srcNotes.forEach((src) => {
      const title = String(src.title || '').trim();
      if (!title) { counts.skipped++; return; }
      const mapped = src.taskId != null && idMap.has(String(src.taskId)) ? idMap.get(String(src.taskId)) : null;
      const key = title + '\u0000' + (mapped == null ? '' : mapped);
      if (noteKeys.has(key)) { counts.skipped++; return; }
      db.notes.push({
        id: nextId(), userId: user.id, taskId: mapped,
        stage: STAGE_NAME[src.stage] ? src.stage : STAGES[0].key,
        module: src.module ? String(src.module).trim() : null,
        title,
        oldProblem: String(src.oldProblem || ''),
        mechanism: String(src.mechanism || ''),
        pitfalls: String(src.pitfalls || ''),
        createdAt: src.createdAt || now, updatedAt: now
      });
      noteKeys.add(key);
      counts.notes++;
    });

    // 3) 打卡（一天一条）
    const days = new Set(ownedCheckins(user.id).map((c) => c.checkinDate));
    srcCheckins.forEach((src) => {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(src.checkinDate || '') ? src.checkinDate : null;
      if (!day || days.has(day)) { counts.skipped++; return; }
      db.checkins.push({
        id: nextId(), userId: user.id, checkinDate: day,
        stage: STAGE_NAME[src.stage] ? src.stage : null,
        note: src.note ? String(src.note).slice(0, 200) : null,
        createdAt: src.createdAt || now
      });
      days.add(day);
      counts.checkins++;
    });

    // 4) 卡点（必须挂得上任务）
    const stuckKeys = new Set(ownedStuck(user.id).map((s) => s.stuckText + '\u0000' + s.enteredAt));
    srcStuck.forEach((src) => {
      const text = String(src.stuckText || '').trim();
      const mapped = src.taskId != null && idMap.has(String(src.taskId)) ? idMap.get(String(src.taskId)) : null;
      if (!text || !mapped) { counts.skipped++; return; }
      const key = text + '\u0000' + (src.enteredAt || '');
      if (stuckKeys.has(key)) { counts.skipped++; return; }
      db.stuck.push({
        id: nextId(), userId: user.id, taskId: mapped, stuckText: text,
        attempts: String(src.attempts || ''),
        nextStep: String(src.nextStep || ''),
        status: src.status === 'closed' ? 'closed' : 'open',
        enteredAt: src.enteredAt || now,
        closedAt: src.status === 'closed' ? (src.closedAt || now) : null
      });
      stuckKeys.add(key);
      counts.stuck++;
    });

    // 5) 按导回来的进度重算「学完」状态
    db.tasks.filter((t) => t.userId === user.id).forEach((t) => recheckLessonDone(user.id, t));

    persist();
    return sendJson(res, 200, { ok: true, saved: true, counts });
  }

  /* ---------- 备份 ---------- */
  if (pathname === '/api/export' && method === 'GET') {
    const payload = {
      exportedAt: new Date().toISOString(),
      user: publicUser(user),
      tasks: ownedTasks(user.id).map((t) => Object.assign(taskOut(t), {
        reviewLog: Array.isArray(t.reviewLog) ? t.reviewLog : []
      })),
      notes: ownedNotes(user.id).map(noteOut),
      checkins: ownedCheckins(user.id).map(checkinOut),
      stuck: ownedStuck(user.id).map(stuckOut)
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="learning-progress-' + todayStr() + '.json"'
    });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* ============================ 启动 ============================ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname, url.searchParams);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, err.message === '请求体不是合法 JSON' ? 400 : 500, {
          error: err.message || '服务器错误'
        });
      }
    }
    return;
  }

  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, users: db.users.length, tasks: db.tasks.length });
  }

  await serveStatic(req, res, pathname);
});

loadDb();
snapshot();
server.listen(PORT, HOST, () => {
  console.log('[learning-progress] listening on ' + HOST + ':' + PORT);
  console.log('[learning-progress] data dir: ' + DATA_DIR);
});

process.on('SIGTERM', () => {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { /* ignore */ }
  server.close(() => process.exit(0));
});
