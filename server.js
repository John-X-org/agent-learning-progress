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
      if (size > 512 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
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

  /* ---------- 备份 ---------- */
  if (pathname === '/api/export' && method === 'GET') {
    const payload = {
      exportedAt: new Date().toISOString(),
      user: publicUser(user),
      tasks: ownedTasks(user.id).map(taskOut),
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
