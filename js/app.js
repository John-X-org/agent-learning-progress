/**
 * js/app.js — 界面与交互
 * 数据全部走 API；课程内容由 /api/curriculum 提供；"学完"的判定在服务端。
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  window.addEventListener('error', function (e) {
    var el = document.getElementById('loginError');
    var app = document.getElementById('appView');
    if (el && app && app.hidden) {
      el.textContent = '页面脚本出错：' + (e.message || '未知错误');
      el.hidden = false;
    }
  });

  var State = {
    me: null,
    stages: [],
    lessons: [],
    lessonById: {},
    lessonTask: {},
    tasks: [],
    notes: [],
    checkins: [],
    stuck: [],
    dash: null,
    view: 'dashboard',
    noteStage: 'all',
    noteQuery: '',
    loading: false,
    pollTimer: null,
    reader: null
  };

  /* ================= 工具 ================= */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

  /** 课程正文里允许 **加粗** 标记：先转义再换标签，顺序不能反 */
  function md(s) { return nl2br(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1700);
  }

  function setSync(kind) {
    var dot = $('#syncDot');
    dot.className = 'dot ' + (kind === 'syncing' ? 'syncing' : kind === 'offline' ? 'offline' : 'online');
    dot.title = kind === 'syncing' ? '正在同步…' : kind === 'offline' ? '连不上服务器' : '已连接';
  }

  function stageName(key) {
    for (var i = 0; i < State.stages.length; i++) if (State.stages[i].key === key) return State.stages[i].name;
    return key || '';
  }

  function hasNote(taskId) {
    if (!taskId) return false;
    return State.notes.some(function (n) { return n.taskId === taskId; });
  }

  /** 单元展示状态（真实判定在服务端 recheckLessonDone） */
  function unitState(t, lesson) {
    if (!t) return { key: 'none', label: '未开始' };
    if (t.status === 'done') return { key: 'done', label: '已学完' };
    if (t.status === 'stuck') return { key: 'stuck', label: '卡住' };
    if (!t.readAt) return { key: 'todo', label: '未开始' };
    if (t.quizBest == null) return { key: 'quiz', label: '待自测' };
    if (t.quizBest < 80) return { key: 'quiz', label: '待重测' };
    if (lesson && lesson.requiresNote && !hasNote(t.id)) return { key: 'note', label: '待写笔记' };
    return { key: 'doing', label: '进行中' };
  }

  /* ================= 弹层 ================= */

  function closeSheet() { $('#modalRoot').innerHTML = ''; }

  function openSheet(opts) {
    var root = $('#modalRoot');
    root.innerHTML =
      '<div class="sheet-mask" data-close="1">' +
        '<div class="sheet" role="dialog" aria-modal="true">' +
          '<div class="sheet-head"><h2>' + esc(opts.title) + '</h2>' +
            '<button class="icon-btn" data-close="1" type="button" aria-label="关闭">✕</button>' +
          '</div>' +
          (opts.hint ? '<p class="sheet-hint">' + opts.hint + '</p>' : '') +
          '<div class="sheet-body">' + (opts.body || '') + '</div>' +
          (opts.actions ? '<div class="sheet-actions">' + opts.actions + '</div>' : '') +
        '</div>' +
      '</div>';
    var mask = root.firstElementChild;
    var sheet = mask.querySelector('.sheet');
    // 只有「点遮罩空白处」或「点弹层内明确标了 data-close 的元素」才关闭。
    // 旧写法 e.target.closest('[data-close]') 会从弹层内部一路冒泡到遮罩自身的 data-close，
    // 结果点输入框/下拉/标题/空白处全会把弹层关掉（打卡弹层"点哪都关"的根因）。
    mask.addEventListener('click', function (e) {
      if (sheet && sheet.contains(e.target)) {
        // 只认弹层内部自己带的 data-close（✕、取消）；遮罩的 data-close 不算
        var closer = e.target.closest('[data-close]');
        if (closer && sheet.contains(closer) && !closer.closest('[data-keep]')) closeSheet();
        return;
      }
      closeSheet();
    });
    if (opts.onMount) opts.onMount(mask);
    return mask;
  }

  function busyBtn(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label || '处理中…';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  /* ================= 登录 ================= */

  function showLoginError(msg) {
    var el = $('#loginError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function showLogin() {
    $('#appView').hidden = true;
    $('#loginView').hidden = false;
    $('#loginLoading').hidden = true;
    $('#loginPanel').hidden = false;
  }

  function showApp() {
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
  }

  async function doLogin() {
    var nick = $('#loginNick').value.trim();
    var pin = $('#loginPin').value.trim();
    if (!nick) { showLoginError('请先填昵称'); $('#loginNick').focus(); return; }
    if (!/^\d{4}$/.test(pin)) { showLoginError('PIN 必须是 4 位数字'); $('#loginPin').focus(); return; }
    showLoginError('');
    var btn = $('#btnLogin');
    busyBtn(btn, true, '登录中…');
    try {
      var res = await API.auth.login(nick, pin);
      State.me = res.user;
      // 云端副本的 key 由「昵称 + PIN」派生：只知昵称算不出来，也就读不到别人的进度
      try { localStorage.setItem(UK_KEY, await sha256Hex('alp:' + nick + ':' + pin)); } catch (e) { /* 隐私模式 */ }
      await enterApp();
      if (res.created) toast('已建好档案，从第一课开始');
    } catch (err) {
      showLoginError(err.message || '登录失败');
      busyBtn(btn, false);
    }
  }

  async function logout() {
    try { await API.auth.logout(); } catch (e) { /* ignore */ }
    State.me = null;
    stopPolling();
    closeSheet();
    closeReader(true);
    $('#loginPin').value = '';
    showLogin();
  }

  async function enterApp() {
    showApp();
    setSync('syncing');
    try {
      await loadCurriculum();
      await loadAll();
      setSync('online');
      startPolling();
    } catch (err) {
      setSync('offline');
      toast(err.message || '读取数据失败');
    }
    renderAll();
    routeFromHash();
    cloudAutoRestore();   // 服务器空 + 云端有备份 → 自动拉回来（不阻塞界面）
  }

  async function loadCurriculum() {
    if (State.lessons.length) return;
    var c = await API.curriculum.get();
    State.stages = c.stages || [];
    State.lessons = c.lessons || [];
    State.lessonById = {};
    State.lessons.forEach(function (l) { State.lessonById[l.id] = l; });
  }

  async function loadAll() {
    var res = await Promise.all([
      API.tasks.list(),
      API.notes.list(),
      API.checkins.list(),
      API.stuck.list(),
      API.dashboard.get()
    ]);
    State.tasks = res[0];
    State.notes = res[1];
    State.checkins = res[2];
    State.stuck = res[3];
    State.dash = res[4];
    State.lessonTask = {};
    State.tasks.forEach(function (t) { if (t.lessonId) State.lessonTask[t.lessonId] = t; });
    saveLocalSnapshot();
    cloudPush();          // 本机快照之后，再往云端存一份（防抖 2.5 秒）
  }

  /* ================= 本机快照：服务器数据被重置时的兜底 =================
     服务端只有一台机器一份磁盘，重新发布/换环境都可能把数据清掉。
     每次加载成功后在本机留一份最近的完整进度，服务端空了就能一键搬回去。 */

  var SNAP_PREFIX = 'alp:snap:v1:';

  function saveLocalSnapshot() {
    if (!State.me || !State.tasks.length) return;
    var prog = State.tasks.filter(function (t) { return t.readAt || t.quizBest != null; }).length +
      State.notes.length + State.checkins.length;
    if (prog === 0) return;   // 空账号不许覆盖已有快照（否则一次误登录就把兜底删了）
    try {
      localStorage.setItem(SNAP_PREFIX + State.me.id, JSON.stringify({
        at: new Date().toISOString(),
        userId: State.me.id,
        nickname: State.me.nickname,
        tasks: State.tasks, notes: State.notes,
        checkins: State.checkins, stuck: State.stuck
      }));
    } catch (e) { /* 隐私模式 / 配额满：不影响正常使用 */ }
  }

  function listSnapshots() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(SNAP_PREFIX) !== 0) continue;
        var s = JSON.parse(localStorage.getItem(k) || 'null');
        if (s && Array.isArray(s.tasks)) out.push(s);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  // 优先拿当前账号自己的；没有就拿这台设备上最近的一份（服务端重置后账号 id 会变）
  function readLocalSnapshot() {
    var all = listSnapshots();
    if (!all.length) return null;
    var myId = State.me && State.me.id;
    if (myId) {
      for (var i = 0; i < all.length; i++) if (all[i].userId === myId) return all[i];
    }
    all.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    return all[0];
  }

  // 快照里"真的有东西"的条数（空任务模板不算）
  function snapshotProgress(s) {
    if (!s) return 0;
    var t = (s.tasks || []).filter(function (x) { return x.readAt || x.quizBest != null; }).length;
    return t + (s.notes || []).length + (s.checkins || []).length + (s.stuck || []).length;
  }

  function agoText(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return '时间不明';
    var m = Math.floor(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  /* ================= 云端进度副本（WorkBuddy 云服务） =================
     主数据仍在自建服务器（判定/越权都在服务端），云端按账号存一份完整副本：
       user_key = sha256('alp:' + 昵称 + ':' + PIN) 的前 32 位
     —— 光知道昵称算不出这个 key，也就读不到别人的进度。
     作用：换设备、服务器磁盘被重置时，登录后自动把进度拉回来。 */

  var CLOUD_CFG = {
    endpoint: 'https://agent-study-checklist.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_63tEdplszNPHm8IB9ZcOwm_QIOr9S1dsVKdRlQJHbNnYTuQ7F63vRp1'
  };
  var UK_KEY = 'alp:uk:v1';
  var cloudClient = null;
  var cloudStat = { state: 'idle', at: null, msg: '' };
  var cloudTimer = null;

  async function sha256Hex(str) {
    if (!window.crypto || !crypto.subtle) return '';
    var h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.prototype.map.call(new Uint8Array(h), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('').slice(0, 32);
  }

  function getCloud() {
    if (cloudClient) return cloudClient;
    if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) {
      cloudStat.state = 'off';
      cloudStat.msg = '云组件没加载';
      return null;
    }
    try {
      cloudClient = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CLOUD_CFG.endpoint,
        oauthRelayBaseUrl: CLOUD_CFG.oauthRelayBaseUrl,
        publishableKey: CLOUD_CFG.publishableKey
      });
    } catch (e) {
      cloudClient = null;
      cloudStat.state = 'off';
      cloudStat.msg = '云组件初始化失败';
    }
    return cloudClient;
  }

  function cloudUserKey() {
    try { return localStorage.getItem(UK_KEY) || ''; } catch (e) { return ''; }
  }

  function cloudPayload() {
    return {
      tasks: State.tasks, notes: State.notes,
      checkins: State.checkins, stuck: State.stuck,
      at: new Date().toISOString()
    };
  }

  function cloudCount(p) {
    if (!p) return 0;
    var t = (p.tasks || []).filter(function (x) { return x.readAt || x.quizBest != null; }).length;
    return t + (p.notes || []).length + (p.checkins || []).length + (p.stuck || []).length;
  }

  function cloudPush(force) {
    var c = getCloud();
    var uk = cloudUserKey();
    if (!c || !uk || !State.me) return;

    var doPush = function () {
      var payload = cloudPayload();
      c.database.from('progress_cloud').upsert({
        user_key: uk,
        nickname: State.me ? State.me.nickname : null,
        payload: payload,
        updated_at: payload.at
      }, { onConflict: 'user_key' }).then(function (r) {
        if (!r || r.error) {
          cloudStat.state = 'error';
          cloudStat.msg = (r && r.error && r.error.message) || '写入失败';
        } else {
          cloudStat.state = 'ok';
          cloudStat.at = payload.at;
          cloudStat.msg = '';
        }
        renderCloudLine();
      }).catch(function () {
        cloudStat.state = 'error';
        cloudStat.msg = '网络不通';
        renderCloudLine();
      });
    };

    if (force) { doPush(); return; }
    if (cloudTimer) return;
    cloudTimer = setTimeout(function () { cloudTimer = null; doPush(); }, 2500);
  }

  function cloudPull() {
    var c = getCloud();
    var uk = cloudUserKey();
    if (!c || !uk) return Promise.resolve(null);
    return c.database.from('progress_cloud')
      .select('payload,updated_at,nickname')
      .eq('user_key', uk)
      .maybeSingle()
      .then(function (r) {
        if (r && !r.error && r.data) {
          cloudStat.state = 'ok';
          cloudStat.at = r.data.updated_at;
          return r.data;
        }
        if (r && r.error) {
          cloudStat.state = 'error';
          cloudStat.msg = (r.error && r.error.message) || '';
        }
        return null;
      }).catch(function () { return null; });
  }

  async function cloudRestore(manual) {
    var row = await cloudPull();
    if (!row) { if (manual) toast('云端还没有这个账号的备份'); return; }
    var p = row.payload || {};
    if (cloudCount(p) === 0) { if (manual) toast('云端备份里没有进度'); return; }
    if (manual && !confirm('把云端备份合并到当前账号？\n云端时间：' +
      String(row.updated_at || '').slice(0, 16).replace('T', ' '))) return;
    try {
      var res = await API.backup.import(p);
      await loadAll();
      renderAll();
      if (State.reader) renderReader();
      var cn = res.counts || {};
      toast('已从云端恢复：进度 ' + ((cn.tasks || 0) + (cn.merged || 0)) +
        ' 条、笔记 ' + (cn.notes || 0) + ' 条、打卡 ' + (cn.checkins || 0) + ' 天');
    } catch (e) { toast(e.message || '云端恢复失败'); }
  }

  // 服务器是空账号、云端却有备份 → 自动拉回来（换设备/服务器被重置时无感恢复）
  async function cloudAutoRestore() {
    if (!State.dash || !State.me) return;
    var d = State.dash;
    var empty = d.readCount === 0 && d.notesCount === 0 && d.activityTotal === 0;
    if (!empty) { cloudPush(); return; }
    var row = await cloudPull();
    if (!row) return;
    if (cloudCount(row.payload || {}) === 0) return;
    try {
      await API.backup.import(row.payload);
      await loadAll();
      renderAll();
      toast('服务器这边是空的，已自动从云端恢复进度');
    } catch (e) { /* 静默：不影响正常使用 */ }
  }

  function cloudStatText() {
    if (!cloudUserKey()) return '重新登录一次即可启用云端同步';
    if (cloudStat.state === 'ok') return '已同步' + (cloudStat.at ? ' · ' + agoText(cloudStat.at) : '');
    if (cloudStat.state === 'error') return '同步失败' + (cloudStat.msg ? '（' + cloudStat.msg + '）' : '');
    if (cloudStat.state === 'off') return '未连接' + (cloudStat.msg ? '（' + cloudStat.msg + '）' : '');
    return '还没同步';
  }

  function renderCloudLine() {
    var el = document.getElementById('cloudState');
    if (el) el.textContent = cloudStatText();
  }


  function startPolling() {
    stopPolling();
    State.pollTimer = setInterval(function () {
      if (document.hidden) return;
      if ($('#modalRoot').innerHTML.trim()) return;
      if (State.reader) return;
      refresh(true);
    }, 45000);
  }
  function stopPolling() {
    if (State.pollTimer) clearInterval(State.pollTimer);
    State.pollTimer = null;
  }

  async function refresh(silent) {
    if (State.loading || !State.me) return;
    State.loading = true;
    setSync('syncing');
    try {
      await loadAll();
      renderAll();
      setSync('online');
      if (!silent) toast('已刷新');
    } catch (err) {
      setSync('offline');
      if (!silent) toast(err.message || '刷新失败');
    } finally {
      State.loading = false;
    }
  }

  /* ================= 看板 ================= */

  function renderDashboard() {
    var d = State.dash;
    if (!d) return;

    $('#totalPct').textContent = d.totalPct + '%';
    var C = 2 * Math.PI * 52;
    var ring = $('#ringFg');
    ring.style.strokeDasharray = C.toFixed(1);
    ring.style.strokeDashoffset = (C * (1 - d.totalPct / 100)).toFixed(1);

    $('#kpDone').textContent = d.done + '/' + d.total;
    $('#caseDone').textContent = d.cases.done + '/' + d.cases.planned;
    $('#quizAvg').textContent = d.quizAvg == null ? '—' : d.quizAvg + '分';

    var colors = { filter: 'var(--stage-1)', decompose: 'var(--stage-2)', explain: 'var(--stage-3)', apply: 'var(--stage-4)' };
    $('#stageBars').innerHTML = d.stages.map(function (s) {
      return '<div class="stage-row">' +
        '<span class="stage-name">' + esc(s.name) + '</span>' +
        '<span class="bar"><i style="width:' + s.pct + '%;background:' + colors[s.key] + '"></i></span>' +
        '<span class="stage-pct">' + s.done + '/' + s.total + '</span>' +
      '</div>';
    }).join('');
    $('#stageSummary').textContent =
      d.stages.filter(function (s) { return s.total && s.done === s.total; }).length + '/4 阶段走完';

    $('#heatmap').innerHTML = d.heatmap.map(function (c) {
      return '<i class="heat-cell l' + c.level + (c.isToday ? ' today' : '') + '"' +
        ' title="' + esc(c.date) + '：' + c.count + ' 次有效动作"' +
        (c.future ? ' style="opacity:.35"' : '') + '></i>';
    }).join('');

    var n = d.nextLesson;
    var card = $('#nextCard');
    if (!n && d.legacyTasks > 0) {
      // 旧版账号：任务里没有挂课程单元，看板没法指路 → 给出迁移入口
      card.innerHTML = '<div class="card next-card">' +
        '<span class="k">升级学习路线</span>' +
        '<b>你的账号里有 ' + esc(d.legacyTasks) + ' 条旧版任务，没有对应的课程内容。</b>' +
        '<p class="muted small">点下面按钮换成 14 个课程单元（旧任务会移除，笔记、打卡、复盘都保留）。</p>' +
        '<button class="btn btn-primary btn-lg" data-act="migrate" type="button">导入 14 个课程单元</button>' +
      '</div>';
    } else if (!n) {
      card.innerHTML = '<div class="card next-card"><span class="k">全部学完</span>' +
        '<b>14 个单元都过了。接下来该去用出来——挑一个真实问题跑一遍。</b></div>';
    } else {
      var t = State.lessonTask[n.lessonId] || null;
      var st = unitState(t, State.lessonById[n.lessonId]);
      card.innerHTML = '<div class="card next-card">' +
        '<span class="k">下一步 · ' + esc(n.stageName) + '</span>' +
        '<b>' + esc(n.title) + '</b>' +
        '<div class="unit-meta">' +
          '<span class="tag ' + (st.key === 'done' ? 'st-done' : 'st-doing') + '">' + esc(st.label) + '</span>' +
          '<span class="muted small">' + (n.read ? '已读过，继续自测' : '约 ' + ((t && t.minutes) || 20) + ' 分钟') + '</span>' +
        '</div>' +
        '<button class="btn btn-primary btn-lg" data-act="open-lesson" data-id="' + esc(n.lessonId || '') + '" type="button">' +
          (n.read ? '继续这一节' : '开始学这一节') + '</button>' +
        (d.legacyTasks > 0
          ? '<button class="btn btn-ghost btn-sm" style="margin-top:10px" data-act="migrate" type="button">清理 ' + esc(d.legacyTasks) + ' 条旧版任务，换课程单元</button>'
          : '') +
      '</div>';
    }

    // 该回测了（间隔复习：学完 3 天 / 7 天 / 21 天 / 60 天各回测一次）
    var rc = $('#reviewCard');
    if (rc) {
      var snap = readLocalSnapshot();
      var looksEmpty = d.readCount === 0 && d.notesCount === 0 && d.activityTotal === 0;
      if (snap && looksEmpty && snapshotProgress(snap) > 0) {
        // 账号是空的，但本机存过一份进度：八成是服务端被重置了
        rc.innerHTML = '<div class="card review-due">' +
          '<div class="card-head"><h2>本机有进度快照</h2>' +
            '<span class="muted small">' + esc(agoText(snap.at)) + '</span></div>' +
          '<p class="small">这台设备存过一份进度（' + snapshotProgress(snap) + ' 条记录），当前账号却是空的——服务端数据可能被重置了。</p>' +
          '<button class="btn btn-primary" data-act="local-restore" type="button">恢复到当前账号</button>' +
          '<p class="muted small" style="margin:8px 0 0">快照属于「' + esc(snap.nickname || '未知') + '」，内容是你本机最后一次看到的完整进度。</p>' +
        '</div>';
      } else if (!d.dueReviews || !d.dueReviews.length) {
        rc.innerHTML = '';
      } else {
        rc.innerHTML = '<div class="card review-due">' +
          '<div class="card-head"><h2>该回测了</h2>' +
            '<span class="muted small">' + d.dueReviews.length + ' 个单元到期</span></div>' +
          d.dueReviews.map(function (r) {
            return '<div class="due-row">' +
              '<div class="due-main"><b>' + esc(r.title) + '</b>' +
                '<span class="muted small">' +
                  (r.overdueDays > 0 ? '超期 ' + r.overdueDays + ' 天' : '今天到期') +
                  (r.lastPct != null ? ' · 上次 ' + r.lastPct + '%'
                    : ' · 首次 ' + (r.firstPct == null ? '—' : r.firstPct + '%')) +
                '</span></div>' +
              '<button class="btn btn-sm btn-primary" data-act="review-lesson" data-id="' + esc(r.lessonId) + '" type="button">回测</button>' +
            '</div>';
          }).join('') +
          '<p class="muted small" style="margin:8px 0 0">复测只记进曲线，不动你的历史最好成绩；间隔按 3 → 7 → 21 → 60 天。</p>' +
        '</div>';
      }
    }

    var alert = $('#stuckAlert');
    if (d.overdueStuckCount > 0) {
      alert.hidden = false;
      alert.innerHTML = '<span>' + d.overdueStuckCount + ' 个卡点超过 2 天还没处理</span>' +
        '<button class="link" data-act="go-queue" type="button">去拆解 ›</button>';
    } else if (d.openStuckCount > 0) {
      alert.hidden = false;
      alert.innerHTML = '<span>' + d.openStuckCount + ' 个卡点在队列里</span>' +
        '<button class="link" data-act="go-queue" type="button">去拆解 ›</button>';
    } else {
      alert.hidden = true;
    }

    var tc = d.todayCheckin;
    $('#checkinStatus').textContent = tc
      ? '今天已打卡' + (tc.stage ? '：' + stageName(tc.stage) : '') + (tc.note ? ' · ' + tc.note : '')
      : '今天还没打卡';
    $('#btnCheckin').textContent = tc ? '补写今天的打卡' : '今日打卡';
  }

  /* ================= 课程列表 ================= */

  function renderCourses() {
    var box = $('#courseList');
    var doneCount = State.lessons.filter(function (l) {
      var t = State.lessonTask[l.id];
      return t && t.status === 'done';
    }).length;
    $('#courseMeta').textContent = doneCount + '/' + State.lessons.length + ' 学完';

    var html = '';
    State.stages.forEach(function (stage) {
      var list = State.lessons.filter(function (l) { return l.stage === stage.key; });
      if (!list.length) return;
      var sd = list.filter(function (l) {
        var t = State.lessonTask[l.id];
        return t && t.status === 'done';
      }).length;

      html += '<div class="tag s-' + stage.key + '" style="justify-self:start;margin-top:6px">' +
        esc(stage.name) + ' · ' + sd + '/' + list.length + '</div>';
      html += '<p class="muted small" style="margin:-4px 0 6px">' + esc(stage.goal || '') + '</p>';

      html += list.map(function (l) {
        var t = State.lessonTask[l.id] || null;
        var st = unitState(t, l);
        var idx = State.lessons.indexOf(l) + 1;
        var tagCls = st.key === 'done' ? 'st-done' : st.key === 'stuck' ? 'st-stuck'
          : (st.key === 'quiz' || st.key === 'note' || st.key === 'doing') ? 'st-doing' : 'st-todo';
        var ess = l.essence.replace(/\*\*/g, '');
        ess = ess.length > 44 ? ess.slice(0, 44) + '…' : ess;
        return '<article class="unit s-' + l.stage + (st.key === 'done' ? ' done' : '') + '" data-act="open-lesson" data-id="' + l.id + '">' +
          '<div class="unit-top">' +
            '<span class="unit-idx">' + idx + '</span>' +
            '<div class="unit-title">' + esc(l.title) + '</div>' +
            '<span class="unit-arrow">›</span>' +
          '</div>' +
          '<div class="unit-sub">' + esc(ess) + '</div>' +
          '<div class="unit-meta">' +
            '<span class="tag ' + tagCls + '">' + esc(st.label) + '</span>' +
            (t && t.quizBest != null ? '<span class="tag">自测 ' + t.quizBest + '%</span>' : '') +
            (hasNote(t && t.id) ? '<span class="tag">有笔记</span>' : '') +
            '<span class="tag">' + (l.minutes || 20) + ' 分钟</span>' +
          '</div>' +
        '</article>';
      }).join('');
    });
    box.innerHTML = html;
  }

  /* ================= 单元阅读器 ================= */

  function openReader(lessonId, opts) {
    var lesson = State.lessonById[lessonId];
    if (!lesson) { toast('这一节还没加载'); return; }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    State.reader = {
      lessonId: lessonId,
      answers: {},
      submitted: false,
      score: null,
      total: lesson.quiz.length,
      hints: 0
    };
    renderReader(opts && opts.scrollToQuiz, opts && opts.resetScroll);
  }

  function chip(ok, label) {
    return '<span class="item2' + (ok ? ' ok' : '') + '">' + (ok ? '✓' : '○') + ' ' + esc(label) + '</span>';
  }

  function sec(n, title, html) {
    return '<div class="sec"><div class="sec-h"><span class="num">' + n + '</span>' + esc(title) + '</div>' + html + '</div>';
  }

  function quizHtml(lesson, r) {
    var letters = ['A', 'B', 'C', 'D', 'E'];
    var html = '';
    if (r.submitted) {
      var pct = Math.round((r.score / r.total) * 100);
      html += '<div class="score ' + (pct >= 80 ? 'pass' : 'fail') + '">' +
        '<div><b>' + pct + '%</b> <span class="muted small">（' + r.score + '/' + r.total + '）</span></div>' +
        '<span class="small muted">' + (pct >= 80 ? '过了，已记录' : '没过 80%，看完解析再答一遍') + '</span>' +
      '</div>';
    }
    lesson.quiz.forEach(function (q, qi) {
      html += '<div class="quiz-q"><div class="qh">' + (qi + 1) + '. ' + md(q.q) + '</div>';
      q.options.forEach(function (opt, oi) {
        var cls = 'opt';
        if (!r.submitted) {
          if (r.answers[qi] === oi) cls += ' sel';
        } else {
          if (oi === q.answer) cls += ' right';
          else if (r.answers[qi] === oi) cls += ' wrong';
        }
        html += '<button class="' + cls + '" data-act="quiz-pick" data-q="' + qi + '" data-o="' + oi + '" type="button"' +
          (r.submitted ? ' disabled' : '') + '>' +
          '<span class="k">' + letters[oi] + '</span><span>' + md(opt) + '</span></button>';
      });
      if (r.submitted) html += '<div class="explain"><b>解析：</b>' + md(q.explain) + '</div>';
      html += '</div>';
    });
    html += r.submitted
      ? '<button class="btn btn-ghost btn-lg" data-act="quiz-reset" type="button">再答一遍</button>'
      : '<button class="btn btn-primary btn-lg" data-act="quiz-submit" type="button">提交自测</button>';
    return html;
  }

  function hintHtml(lesson, r) {
    var labels = ['先给我一个方向', '再给具体步骤', '直接看答案'];
    var html = '';
    for (var i = 0; i < r.hints; i++) {
      html += '<div class="hint-box"><b>第 ' + (i + 1) + ' 层：</b>' + md(lesson.hints[i]) + '</div>';
    }
    if (r.hints < 3) {
      html += '<button class="btn btn-ghost btn-sm" style="margin-top:10px" data-act="hint-next" type="button">' +
        labels[r.hints] + '（' + (r.hints + 1) + '/3）</button>';
    } else {
      html += '<p class="muted small" style="margin-top:10px">三层都看完了。还不通就点底部「卡住」，把它记进队列。</p>';
    }
    return html;
  }

  function pendingText(task, lesson) {
    var miss = [];
    if (!(task && task.readAt)) miss.push('标记已读');
    if (!(task && task.quizBest != null && task.quizBest >= 80)) miss.push('自测到 80%');
    if (lesson.requiresNote && !hasNote(task && task.id)) miss.push('交一条三层笔记');
    return miss.length ? '还差：' + miss.join('、') : '';
  }

  function renderReader(scrollToQuiz, resetScroll) {
    var r = State.reader;
    if (!r) return;
    var lesson = State.lessonById[r.lessonId];
    var task = State.lessonTask[r.lessonId] || null;
    var st = unitState(task, lesson);
    // 重渲染后要把滚动位置放回去，否则点一次按钮页面就跳回顶部；换到下一节则回到顶部
    var oldEl = document.getElementById('reader');
    var keepTop = resetScroll ? 0 : (oldEl ? oldEl.scrollTop : 0);

    // 上一节 / 下一节：按 L1→L14 的学习顺序排
    var idx = -1;
    for (var i = 0; i < State.lessons.length; i++) {
      if (State.lessons[i].id === lesson.id) { idx = i; break; }
    }
    var nextL = idx >= 0 ? State.lessons[idx + 1] || null : null;
    var readDone = !!(task && task.readAt);

    var body = '';
    body += '<div class="essence">' + md(lesson.essence) + '</div>';

    body += '<div class="req">' +
      chip(task && task.readAt, '已读') +
      chip(task && task.quizBest != null && task.quizBest >= 80,
        '自测' + (task && task.quizBest != null ? ' ' + task.quizBest + '%' : '')) +
      chip(hasNote(task && task.id), lesson.requiresNote ? '笔记（必须）' : '笔记') +
    '</div>';

    // 间隔复测：学完的单元才有复测日
    if (task && task.status === 'done' && task.reviewDue) {
      var dueMs = new Date(task.reviewDue).getTime();
      var overdue = dueMs <= Date.now();
      var dueTxt = task.reviewDue.slice(5, 10);
      body += '<p class="review-line' + (overdue ? ' due' : '') + '">' +
        (overdue ? '⏰ 该回测了（原定 ' + esc(dueTxt) + '）' : '下次回测：' + esc(dueTxt)) +
        (task.reviewCount ? ' · 已回测 ' + task.reviewCount + ' 次' : '') +
        (task.reviewLast ? ' · 上次 ' + task.reviewLast.pct + '%' : '') +
      '</p>';
    }

    // 正文可信度：机器查过的 ≠ 人核对过的，必须让读者一眼看到差别
    var rv = lesson.review || { level: 'none', pending: [] };
    body += '<div class="review-badge ' + (rv.level === 'human' ? 'is-human' : 'is-machine') + '">' +
      (rv.level === 'human'
        ? '✓ 已人工核对' + (rv.by ? '（' + esc(rv.by) + '）' : '') + (rv.at ? ' · ' + esc(rv.at) : '')
        : '⚠ 只过了机器检查（结构/代码语法/答案索引），事实还没人核对' +
          (rv.pending && rv.pending.length ? ' · ' + rv.pending.length + ' 点待确认' : '')) +
    '</div>';
    if (rv.pending && rv.pending.length) {
      body += '<details class="review-pending"><summary>这节还有 ' + rv.pending.length +
        ' 点需要人看一眼（点开看清单）</summary><ul>' +
        rv.pending.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') +
      '</ul></details>';
    }

    body += sec(1, '为什么需要它', '<p class="p">' + md(lesson.why) + '</p>' +
      '<div class="quote" style="margin-top:12px">' + md(lesson.metaphor) + '</div>');

    body += sec(2, '机制拆解', lesson.points.map(function (p) {
      return '<div class="point"><h4>' + esc(p.h) + '</h4><p>' + md(p.p) + '</p></div>';
    }).join(''));

    body += sec(3, '动手（照着做一遍）', lesson.steps.map(function (s) {
      return '<div class="point"><h4>' + esc(s.h) + '</h4><p>' + md(s.p) + '</p>' +
        (s.code
          ? '<div class="code-wrap"><pre class="code">' + esc(s.code) + '</pre>' +
            '<button class="copy-btn" data-act="copy" data-code="' + esc(s.code) + '" type="button">复制</button></div>'
          : '') +
        '</div>';
    }).join(''));

    body += sec(4, '踩坑清单', lesson.pitfalls.map(function (p) {
      return '<div class="pit"><span class="x">✕</span><div>' + md(p.p) +
        '<span class="fix"><b>修法：</b>' + md(p.fix) + '</span></div></div>';
    }).join(''));

    body += sec(5, '自测（≥80% 算过）', '<div id="quizBox">' + quizHtml(lesson, r) + '</div>');

    body += sec(6, '追问自答', lesson.followups.map(function (f) {
      return '<details class="fq"><summary>' + esc(f.q) + '</summary>' +
        '<div class="ans">' + md(f.a) + '</div></details>';
    }).join(''));

    body += sec(7, '卡住了？一层一层看提示', '<div class="hint-tier" id="hintTier">' + hintHtml(lesson, r) + '</div>');

    // 读到末尾就能直接进下一节，不用先返回课程列表
    body += '<div class="reader-end">' +
      (st.key === 'done'
        ? '<div class="end-done">✓ 这一节学完了，接着往下走</div>'
        : '<div class="end-pending">' + esc(pendingText(task, lesson) || '这一节还没算学完') + '</div>') +
      (nextL
        ? '<button class="btn btn-primary btn-lg" data-act="lesson-next" data-id="' + esc(nextL.id) + '" type="button">下一节：' +
            esc(nextL.title) + ' ›</button>'
        : '<button class="btn btn-primary btn-lg" data-act="go-courses" type="button">这是最后一节，回课程列表</button>') +
    '</div>';

    $('#readerRoot').innerHTML =
      '<div class="reader" id="reader">' +
        '<div class="reader-bar">' +
          '<button class="back" data-act="close-reader" type="button" aria-label="返回">‹</button>' +
          '<div class="rt"><b>' + esc(lesson.title) + '</b>' +
            '<span>' + esc(stageName(lesson.stage)) + ' · ' + esc(lesson.module || '') + ' · ' + (lesson.minutes || 20) + ' 分钟</span></div>' +
          '<span class="tag ' + (st.key === 'done' ? 'st-done' : st.key === 'stuck' ? 'st-stuck' : 'st-doing') + '">' + esc(st.label) + '</span>' +
        '</div>' +
        '<div class="reader-body">' + body + '</div>' +
        '<div class="reader-foot"><div class="inner">' +
          (readDone
            ? '<button class="btn btn-ghost" data-act="lesson-note" type="button">写笔记</button>' +
              '<button class="btn btn-ghost" data-act="lesson-stuck" type="button">卡住</button>' +
              (nextL
                ? '<button class="btn btn-primary wide" data-act="lesson-next" data-id="' + esc(nextL.id) + '" type="button">下一节 ›</button>'
                : '<button class="btn btn-primary wide" data-act="go-courses" type="button">回课程列表</button>')
            : '<button class="btn btn-primary wide" data-act="mark-read" type="button">标记已读</button>' +
              '<button class="btn btn-ghost" data-act="lesson-note" type="button">写笔记</button>' +
              '<button class="btn btn-ghost" data-act="lesson-stuck" type="button">卡住</button>') +
        '</div></div>' +
      '</div>';

    if (scrollToQuiz) {
      var q = $('#quizBox');
      if (q) q.scrollIntoView({ block: 'center' });
    } else if (keepTop) {
      var el = document.getElementById('reader');
      if (el) el.scrollTop = keepTop;
    }
    document.body.style.overflow = 'hidden';
  }

  function closeReader(silent) {
    $('#readerRoot').innerHTML = '';
    State.reader = null;
    document.body.style.overflow = '';
    if (!silent && (location.hash || '').indexOf('#lesson/') === 0) {
      try { history.replaceState(null, '', '#' + (State.view || 'courses')); } catch (e) { /* ignore */ }
    }
  }

  /* ================= 交互：阅读器 ================= */

  async function markRead() {
    var r = State.reader;
    if (!r) return;
    var task = State.lessonTask[r.lessonId];
    if (!task) { toast('这一节缺少任务记录'); return; }
    try {
      var res = await API.tasks.progress(task.id, { read: true });
      await loadAll();
      renderAll();
      renderReader();
      toast(res.state && res.state.done ? '已读完，这一节学完了 ✓' : '已标记已读，接着做自测');
    } catch (err) {
      toast(err.message || '保存失败');
    }
  }

  async function submitQuiz() {
    var r = State.reader;
    if (!r) return;
    var lesson = State.lessonById[r.lessonId];
    if (Object.keys(r.answers).length < lesson.quiz.length) {
      toast('还有题没答');
      return;
    }
    var score = 0;
    lesson.quiz.forEach(function (q, i) { if (r.answers[i] === q.answer) score++; });

    var task = State.lessonTask[r.lessonId];
    if (!task) { toast('这一节缺少任务记录'); return; }
    var wasDone = task.status === 'done';   // 学完之后再答一遍 = 复测

    try {
      var res = await API.tasks.progress(task.id, {
        quizScore: score,
        quizTotal: lesson.quiz.length,
        read: true
      });
      r.submitted = true;
      r.score = score;
      var pct = Math.round((score / lesson.quiz.length) * 100);

      if (wasDone) {
        // 复测：单独记一条曲线，并顺延下次回测日
        var gap = 3;
        try {
          var rv = await API.tasks.review(task.id, { quizScore: score, quizTotal: lesson.quiz.length });
          gap = (rv && rv.nextGapDays) || gap;
        } catch (e) { /* 复测记录失败不影响这次答题结果 */ }
        await loadAll();
        renderAll();
        renderReader();
        toast('复测 ' + pct + '% · ' + gap + ' 天后再回测');
        return;
      }

      await loadAll();
      renderAll();
      renderReader();
      toast(pct >= 80 ? '自测通过 ' + pct + '%' : '得分 ' + pct + '%，看解析再答一次');
      if (res.state && res.state.done) {
        setTimeout(function () { toast('这一节学完了 ✓'); }, 900);
      } else if (res.state && res.state.needNote && !res.state.hasNote) {
        setTimeout(function () { toast('还差一条笔记才算学完'); }, 900);
      }
    } catch (err) {
      toast(err.message || '提交失败');
    }
  }

  /* ================= 渲染：笔记 ================= */

  function renderNotes() {
    var q = State.noteQuery.trim().toLowerCase();
    var list = State.notes.filter(function (n) {
      if (State.noteStage !== 'all' && n.stage !== State.noteStage) return false;
      if (!q) return true;
      return [n.title, n.oldProblem, n.mechanism, n.pitfalls, n.module]
        .join(' ').toLowerCase().indexOf(q) >= 0;
    });

    var box = $('#noteList');
    if (!list.length) {
      box.innerHTML = '<p class="empty">' +
        (State.notes.length ? '没有匹配的笔记。' : '还没有笔记。学完一节就写一条三层笔记。') + '</p>';
      return;
    }

    box.innerHTML = list.map(function (n) {
      var task = State.tasks.filter(function (t) { return t.id === n.taskId; })[0];
      var lesson = task && task.lessonId ? State.lessonById[task.lessonId] : null;
      return '<article class="item">' +
        '<div class="item-top">' +
          '<div class="item-title">' + esc(n.title) + '</div>' +
          '<button class="icon-btn" data-act="note-edit" data-id="' + n.id + '" type="button" aria-label="编辑">⋯</button>' +
        '</div>' +
        '<div class="item-meta">' +
          '<span class="tag s-' + n.stage + '">' + esc(stageName(n.stage)) + '</span>' +
          (lesson ? '<span class="tag" data-act="open-lesson" data-id="' + lesson.id + '">' + esc(lesson.title) + '</span>' : '') +
          '<span class="tag">' + esc(String(n.createdAt || '').slice(0, 10)) + '</span>' +
        '</div>' +
        '<div class="note-body">' +
          '<div class="note-field"><span class="k">① 它解决的旧问题</span><span class="v">' + esc(n.oldProblem || '—') + '</span></div>' +
          '<div class="note-field"><span class="k">② 核心机制的比喻</span><span class="v">' + esc(n.mechanism || '—') + '</span></div>' +
          '<div class="note-field"><span class="k">③ 踩坑与修法</span><span class="v">' + esc(n.pitfalls || '—') + '</span></div>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  /* ================= 渲染：队列 ================= */

  function renderQueue() {
    var open = State.stuck.filter(function (s) { return s.status === 'open'; });
    var closed = State.stuck.filter(function (s) { return s.status === 'closed'; }).slice(0, 6);
    var taskById = {};
    State.tasks.forEach(function (t) { taskById[t.id] = t; });

    $('#queueMeta').textContent = open.length ? open.length + ' 个待处理' : '队列是空的';

    var badge = $('#queueBadge');
    var overdue = open.filter(function (s) { return s.days > 2; }).length;
    if (open.length) {
      badge.hidden = false;
      badge.textContent = open.length;
      badge.style.background = overdue ? 'var(--danger)' : 'var(--muted)';
    } else {
      badge.hidden = true;
    }

    var html = open.map(function (s) {
      var t = taskById[s.taskId];
      return '<article class="item">' +
        '<div class="item-meta">' +
          '<span class="tag">卡住 <span class="days' + (s.days > 2 ? ' over' : '') + '">' + s.days + '</span> 天</span>' +
          (t ? '<span class="tag s-' + t.stage + '">' + esc(stageName(t.stage)) + '</span>' : '') +
        '</div>' +
        (t ? '<div class="item-title"' + (t.lessonId ? ' data-act="open-lesson" data-id="' + t.lessonId + '"' : '') + '>' +
          esc(t.title) + '</div>' : '') +
        '<div class="stuck-text">' + esc(s.stuckText) + '</div>' +
        (s.attempts ? '<div class="note-field"><span class="k">已尝试</span><span class="v">' + esc(s.attempts) + '</span></div>' : '') +
        '<div class="note-field"><span class="k">下一步最小尝试</span><span class="v">' + esc(s.nextStep || '（还没写，补一个）') + '</span></div>' +
        '<div class="actions">' +
          '<button class="btn btn-sm btn-ghost" data-act="stuck-edit" data-id="' + s.id + '" type="button">更新下一步</button>' +
          '<button class="btn btn-sm btn-primary" data-act="stuck-close" data-id="' + s.id + '" type="button">已解决</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="stuck-note" data-id="' + s.id + '" type="button">沉淀成笔记</button>' +
        '</div>' +
      '</article>';
    }).join('');

    if (closed.length) {
      html += '<div class="tag" style="justify-self:start;margin-top:8px">最近关闭</div>';
      html += closed.map(function (s) {
        var t = taskById[s.taskId];
        return '<article class="item">' +
          '<div class="item-top"><div class="item-title done">' +
            esc(t ? t.title : String(s.stuckText || '').slice(0, 24)) + '</div>' +
            '<button class="icon-btn" data-act="stuck-reopen" data-id="' + s.id + '" type="button" aria-label="重新打开">↺</button></div>' +
          '<div class="item-meta"><span class="tag">' + esc(String(s.closedAt || '').slice(0, 10)) + ' 关闭</span></div>' +
        '</article>';
      }).join('');
    }

    $('#queueList').innerHTML = html || '<p class="empty">没有卡在队列里的事。</p>';
  }

  /* ================= 渲染：复盘 ================= */

  function renderReview() {
    var d = State.dash;
    if (!d) return;
    var labels = ['本周', '上周', '两周前', '三周前'];
    $('#reviewList').innerHTML = d.reviews.map(function (r, i) {
      return '<article class="card">' +
        '<div class="card-head"><h2>' + labels[i] + '复盘</h2>' +
          '<span class="muted small">' + r.weekStart.slice(5) + ' – ' + r.weekEnd.slice(5) + '</span></div>' +
        '<p class="review-sentence">' + esc(r.sentence) + '</p>' +
        '<div class="review-facts">' +
          '<span class="fact">有效动作 ' + r.total + '</span>' +
          '<span class="fact">笔记 ' + r.noteCount + '</span>' +
          '<span class="fact">未闭环卡点 ' + r.openStucks + '</span>' +
        '</div>' +
      '</article>';
    }).join('');

    var name = (State.me && State.me.nickname) || '学习者';
    var ret = d.retention || { count: 0, avgDecay: null };
    var retTxt;
    if (!ret.count) retTxt = '还没回测记录';
    else if (ret.avgDecay <= -1) retTxt = '比首次退步 ' + Math.abs(ret.avgDecay) + ' 分（' + ret.count + ' 个已回测）';
    else if (ret.avgDecay >= 1) retTxt = '比首次还高 ' + ret.avgDecay + ' 分（' + ret.count + ' 个已回测）';
    else retTxt = '跟首次持平（' + ret.count + ' 个已回测）';

    var snap = readLocalSnapshot();
    var snapLine = snap
      ? '<div class="account-line"><span class="k">本机快照</span><span class="small muted">' +
          esc(agoText(snap.at)) + ' · ' + snapshotProgress(snap) + ' 条</span></div>'
      : '<div class="account-line"><span class="k">本机快照</span><span class="small muted">还没有</span></div>';

    $('#accountBox').innerHTML =
      '<div class="account-line"><span class="k">昵称</span><span>' + esc(name) + '</span></div>' +
      '<div class="account-line"><span class="k">档案创建</span><span class="small muted">' +
        esc(String((State.me && State.me.createdAt) || '').slice(0, 10)) + '</span></div>' +
      '<div class="account-line"><span class="k">记忆留存</span><span class="small">' + esc(retTxt) + '</span></div>' +
      snapLine +
      '<div class="account-line"><span class="k">云端备份</span><span class="small" id="cloudState">' +
        esc(cloudStatText()) + '</span></div>' +
      '<div class="actions">' +
        '<button class="btn btn-sm btn-ghost" data-act="edit-nickname" type="button">改昵称</button>' +
        '<a class="btn btn-sm btn-ghost" href="' + API.exportUrl + '" download>导出备份</a>' +
        '<button class="btn btn-sm btn-ghost" data-act="import-backup" type="button">导入备份</button>' +
        (snap && snapshotProgress(snap) > 0
          ? '<button class="btn btn-sm btn-ghost" data-act="local-restore" type="button">用本机快照恢复</button>'
          : '') +
        '<button class="btn btn-sm btn-ghost" data-act="cloud-push" type="button">立即备份到云端</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="cloud-restore" type="button">从云端恢复</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="logout" type="button">退出登录</button>' +
      '</div>' +
      '<p class="small muted" style="margin:2px 0 0">备份是一个 JSON 文件；本机快照是这台设备自动留的一份。' +
        '换设备、或者服务端数据被重置后，两者都能把进度搬回来（同一条进度不会重复记）。</p>';
  }

  function renderAll() {
    renderDashboard();
    renderCourses();
    renderNotes();
    renderQueue();
    renderReview();
    $('#userChip').textContent = (State.me && State.me.nickname) || '学习者';
  }

  /* ================= 路由 ================= */

  var VIEWS = ['dashboard', 'courses', 'notes', 'queue', 'review'];

  function go(v, silent) {
    if (VIEWS.indexOf(v) < 0) v = 'dashboard';
    State.view = v;
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (el) {
      el.hidden = el.getAttribute('data-view') !== v;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (el) {
      el.classList.toggle('active', el.getAttribute('data-target') === v);
    });
    if (!silent) {
      try { history.replaceState(null, '', '#' + v); } catch (e) { /* ignore */ }
    }
    window.scrollTo(0, 0);
  }

  function routeFromHash() {
    var h = (location.hash || '').replace('#', '');
    if (h.indexOf('lesson/') === 0) {
      var id = h.split('/')[1];
      if (State.lessonById[id]) { openReader(id); return; }
    }
    go(VIEWS.indexOf(h) >= 0 ? h : (State.view || 'dashboard'), true);
  }

  /* ================= 交互：卡点 ================= */

  function openTaskStuckSheet(taskId) {
    var t = State.tasks.filter(function (x) { return x.id === taskId; })[0];
    if (!t) return;
    openSheet({
      title: '记下这个卡点',
      hint: '卡点写清"具体在哪一步、报什么错"；下一步写成能 15 分钟做完的动作。',
      body:
        '<label class="field"><span class="field-label">卡点原文（必须）</span>' +
          '<textarea id="stuckText" placeholder="例：按第 3 步跑，报 ModuleNotFoundError: No module named langchain_openai"></textarea></label>' +
        '<label class="field"><span class="field-label">已经试过什么</span>' +
          '<textarea id="stuckTried" placeholder="例：重装依赖、换 python 版本、看报错路径"></textarea></label>' +
        '<label class="field"><span class="field-label">下一步最小尝试</span>' +
          '<textarea id="stuckNext" placeholder="例：用 python -c 打印 sys.path，确认装到了哪个解释器"></textarea></label>',
      actions: '<button class="btn btn-ghost" data-close="1" type="button">取消</button>' +
        '<button class="btn btn-primary" id="btnSaveStuck" type="button">进队列</button>',
      onMount: function () {
        $('#btnSaveStuck').addEventListener('click', async function () {
          var text = $('#stuckText').value.trim();
          if (!text) { toast('卡点原文不能空'); $('#stuckText').focus(); return; }
          var btn = this;
          busyBtn(btn, true, '保存中…');
          try {
            await API.stuck.open({
              taskId: taskId,
              stuckText: text,
              attempts: $('#stuckTried').value.trim(),
              nextStep: $('#stuckNext').value.trim()
            });
            closeSheet();
            await loadAll();
            renderAll();
            toast('已进拆解队列');
            go('queue');
          } catch (err) {
            toast(err.message || '保存失败');
            busyBtn(btn, false);
          }
        });
      }
    });
  }

  /* ================= 交互：笔记 ================= */

  function openNoteEditor(note, prefill) {
    var isNew = !note;
    var n = note || prefill || {
      stage: 'filter', title: '', oldProblem: '', mechanism: '', pitfalls: '', taskId: null
    };
    var lessonOptions = '<option value="">不关联</option>' + State.lessons.map(function (l) {
      var t = State.lessonTask[l.id];
      if (!t) return '';
      return '<option value="' + t.id + '"' + (String(n.taskId) === String(t.id) ? ' selected' : '') + '>' +
        esc(stageName(l.stage)) + ' · ' + esc(l.title) + '</option>';
    }).join('');

    openSheet({
      title: isNew ? '写一条三层笔记' : '编辑笔记',
      hint: '三层：它解决的旧问题 → 核心机制的比喻 → 踩坑与修法。缺一层，笔记就退化成摘抄。',
      body:
        '<label class="field"><span class="field-label">标题</span>' +
          '<input id="fNoteTitle" type="text" value="' + esc(n.title) + '" placeholder="一句话说清这条笔记讲什么" /></label>' +
        '<label class="field"><span class="field-label">阶段</span>' +
          '<select id="fNoteStage">' + State.stages.map(function (s) {
            return '<option value="' + s.key + '"' + (n.stage === s.key ? ' selected' : '') + '>' + esc(s.name) + '</option>';
          }).join('') + '</select></label>' +
        '<label class="field"><span class="field-label">关联单元</span>' +
          '<select id="fNoteTask">' + lessonOptions + '</select></label>' +
        '<label class="field"><span class="field-label">① 它解决的旧问题</span>' +
          '<textarea id="fNoteOld" placeholder="例：以前以为它记住了，其实每轮都得把历史重发一遍">' + esc(n.oldProblem) + '</textarea></label>' +
        '<label class="field"><span class="field-label">② 核心机制的比喻式说明（四行映射 + 一行边界）</span>' +
          '<textarea id="fNoteMech" style="min-height:110px" placeholder="像记事本：历史↔本子；每轮↔抄一遍；裁剪↔撕掉最早几页；边界：它不会自己翻页">' + esc(n.mechanism) + '</textarea></label>' +
        '<label class="field"><span class="field-label">③ 踩坑与修法（现象/复现条件/根因/修法/验证）</span>' +
          '<textarea id="fNotePit" style="min-height:110px" placeholder="现象：报 400；复现：第二轮；根因：tool 消息缺 id；修法：带 call.id；验证：去掉 id 应复现">' + esc(n.pitfalls) + '</textarea></label>',
      actions: (isNew ? '' : '<button class="btn btn-danger" id="btnDelNote" type="button">删除</button>') +
        '<button class="btn btn-primary" id="btnSaveNote" type="button">保存</button>',
      onMount: function () {
        $('#btnSaveNote').addEventListener('click', async function () {
          var payload = {
            title: $('#fNoteTitle').value.trim(),
            stage: $('#fNoteStage').value,
            taskId: $('#fNoteTask').value ? Number($('#fNoteTask').value) : null,
            oldProblem: $('#fNoteOld').value.trim(),
            mechanism: $('#fNoteMech').value.trim(),
            pitfalls: $('#fNotePit').value.trim()
          };
          if (!payload.title) { toast('标题不能空'); return; }
          if (!payload.oldProblem && !payload.mechanism && !payload.pitfalls) {
            toast('三层至少写一层'); return;
          }
          var btn = this;
          busyBtn(btn, true, '保存中…');
          try {
            if (isNew) await API.notes.create(payload);
            else await API.notes.update(note.id, payload);
            closeSheet();
            await loadAll();
            renderAll();
            if (State.reader) renderReader();
            toast('已保存');
          } catch (err) {
            toast(err.message || '保存失败');
            busyBtn(btn, false);
          }
        });
        var del = $('#btnDelNote');
        if (del) del.addEventListener('click', async function () {
          if (!confirm('删除这条笔记？')) return;
          try {
            await API.notes.remove(note.id);
            closeSheet();
            await loadAll();
            renderAll();
            toast('已删除');
          } catch (err) { toast(err.message || '删除失败'); }
        });
      }
    });
  }

  /* ================= 交互：导入备份 ================= */

  async function importBackupFile(file) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { toast('备份文件太大（超过 4MB）'); return; }

    var text;
    try { text = await file.text(); } catch (err) { toast('这个文件读不出来'); return; }
    var payload;
    try { payload = JSON.parse(text); } catch (err) { toast('不是合法的 JSON 备份文件'); return; }

    toast('正在导入…');
    try {
      var res = await API.backup.import(payload);
      var c = res.counts || {};
      await loadAll();
      renderAll();
      if (State.reader) renderReader();
      toast('已导入：进度 ' + ((c.tasks || 0) + (c.merged || 0)) + ' 条、笔记 ' + (c.notes || 0) +
        ' 条、打卡 ' + (c.checkins || 0) + ' 天、卡点 ' + (c.stuck || 0) + ' 条' +
        (c.skipped ? '（跳过重复 ' + c.skipped + ' 条）' : ''));
    } catch (err) {
      toast(err.message || '导入失败');
    }
  }

  /* ================= 交互：打卡 ================= */

  function openCheckinSheet() {
    var todayRow = State.dash && State.dash.todayCheckin;
    var cur = todayRow ? todayRow.stage : '';
    openSheet({
      title: '今日打卡',
      hint: '打卡不是仪式，是给热力图一格颜色。选今天主要推进的阶段，可留一句话。',
      body:
        '<label class="field"><span class="field-label">今天主要推进</span>' +
          '<select id="fCkStage"><option value="">不指定</option>' + State.stages.map(function (s) {
            return '<option value="' + s.key + '"' + (cur === s.key ? ' selected' : '') + '>' + esc(s.name) + '</option>';
          }).join('') + '</select></label>' +
        '<label class="field"><span class="field-label">一句话（可选）</span>' +
          '<input id="fCkNote" type="text" maxlength="60" value="' + esc(todayRow ? (todayRow.note || '') : '') +
          '" placeholder="例：把 Tool Calling 的 loop 手写了一遍" /></label>',
      actions: '<button class="btn btn-ghost" data-close="1" type="button">取消</button>' +
        '<button class="btn btn-primary" id="btnSaveCheckin" type="button">打卡</button>',
      onMount: function () {
        $('#btnSaveCheckin').addEventListener('click', async function () {
          var btn = this;
          busyBtn(btn, true, '保存中…');
          try {
            await API.checkins.save(API.today(), $('#fCkStage').value || null, $('#fCkNote').value.trim() || null);
            closeSheet();
            await loadAll();
            renderAll();
            toast('已保存');
          } catch (err) {
            toast(err.message || '打卡失败');
            busyBtn(btn, false);
          }
        });
      }
    });
  }

  /* ================= 交互：队列 ================= */

  function openStuckEdit(id) {
    var s = State.stuck.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    openSheet({
      title: '更新这个卡点',
      body:
        '<label class="field"><span class="field-label">卡点原文</span>' +
          '<textarea id="fSeText">' + esc(s.stuckText) + '</textarea></label>' +
        '<label class="field"><span class="field-label">已尝试</span>' +
          '<textarea id="fSeTried">' + esc(s.attempts || '') + '</textarea></label>' +
        '<label class="field"><span class="field-label">下一步最小尝试</span>' +
          '<textarea id="fSeNext">' + esc(s.nextStep || '') + '</textarea></label>',
      actions: '<button class="btn btn-ghost" data-close="1" type="button">取消</button>' +
        '<button class="btn btn-primary" id="btnSaveStuckEdit" type="button">保存</button>',
      onMount: function () {
        $('#btnSaveStuckEdit').addEventListener('click', async function () {
          var btn = this;
          busyBtn(btn, true, '保存中…');
          try {
            await API.stuck.update(id, {
              stuckText: $('#fSeText').value.trim(),
              attempts: $('#fSeTried').value.trim(),
              nextStep: $('#fSeNext').value.trim()
            });
            closeSheet();
            await loadAll();
            renderAll();
            toast('已保存');
          } catch (err) {
            toast(err.message || '保存失败');
            busyBtn(btn, false);
          }
        });
      }
    });
  }

  function openStuckClose(id) {
    var s = State.stuck.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var task = State.tasks.filter(function (t) { return t.id === s.taskId; })[0];
    openSheet({
      title: '卡点解决了',
      hint: '关掉之后，这个单元回到哪个状态？',
      body: '<div class="actions" style="display:grid;gap:8px">' +
        '<button class="btn btn-primary" data-close-stuck="doing" type="button">继续学这一节</button>' +
        '<button class="btn btn-ghost" data-close-stuck="done" type="button">整个单元都过了，直接算学完</button>' +
      '</div>',
      onMount: function (mask) {
        Array.prototype.forEach.call(mask.querySelectorAll('[data-close-stuck]'), function (btn) {
          btn.addEventListener('click', async function () {
            var next = btn.getAttribute('data-close-stuck');
            busyBtn(btn, true, '保存中…');
            try {
              await API.stuck.close(id);
              if (task) await API.tasks.update(task.id, { status: next });
              closeSheet();
              await loadAll();
              renderAll();
              if (State.reader) renderReader();
              toast('已关闭卡点');
            } catch (err) {
              toast(err.message || '操作失败');
              busyBtn(btn, false);
            }
          });
        });
      }
    });
  }

  function openStuckNote(id) {
    var s = State.stuck.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var task = State.tasks.filter(function (t) { return t.id === s.taskId; })[0];
    var lesson = task && task.lessonId ? State.lessonById[task.lessonId] : null;
    closeSheet();
    openNoteEditor(null, {
      stage: task ? task.stage : 'decompose',
      title: lesson ? ('踩坑：' + lesson.title) : '踩坑记录',
      oldProblem: s.stuckText || '',
      mechanism: '',
      pitfalls: (s.attempts ? '已试：' + s.attempts + '\n' : '') + (s.nextStep ? '修法：' + s.nextStep : ''),
      taskId: s.taskId
    });
  }

  /* ================= 事件绑定 ================= */

  /* ================= 主题（默认亮色，暗色可选） ================= */

  function themeIcons() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var sun = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0-5v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 16.3l-1.4 1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
    var moon = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 8.5 8.5 0 1 0 21 14.5z" fill="currentColor"/></svg>';
    var icon = dark ? sun : moon;
    var b1 = $('#btnTheme');
    var b2 = $('#btnThemeLogin');
    if (b1) b1.innerHTML = icon;
    if (b2) b2.innerHTML = icon;
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = t === 'dark' ? '#0f1219' : '#f5f7fb';
    try { localStorage.setItem('alp-theme', t); } catch (e) { /* ignore */ }
    themeIcons();
  }

  function toggleTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  }

  /* ================= 交互绑定 ================= */

  function bind() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    $('#btnTheme').addEventListener('click', toggleTheme);
    $('#btnThemeLogin').addEventListener('click', toggleTheme);

    $('#btnLogin').addEventListener('click', doLogin);
    $('#loginPin').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

    $('#btnRefresh').addEventListener('click', function () { refresh(false); });
    $('#userChip').addEventListener('click', function () { go('review'); });

    $('#tabbar').addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (tab) {
        if (State.reader) closeReader(true);
        go(tab.getAttribute('data-target'));
      }
    });

    $('#noteFilter').addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (!b) return;
      State.noteStage = b.getAttribute('data-stage');
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('active', c === b); });
      renderNotes();
    });

    $('#noteSearch').addEventListener('input', function () {
      State.noteQuery = this.value;
      renderNotes();
    });

    $('#btnAddNote').addEventListener('click', function () {
      openNoteEditor(null, {
        stage: State.noteStage === 'all' ? 'filter' : State.noteStage,
        title: '', oldProblem: '', mechanism: '', pitfalls: '', taskId: null
      });
    });
    $('#btnCheckin').addEventListener('click', openCheckinSheet);

    var importFile = $('#importFile');
    if (importFile) {
      importFile.addEventListener('change', function () {
        importBackupFile(this.files && this.files[0]);
      });
    }

    document.addEventListener('click', async function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var act = el.getAttribute('data-act');
      var id = el.getAttribute('data-id');
      var numId = Number(id);

      if (act === 'go-queue') { go('queue'); return; }
      if (act === 'migrate') {
        busyBtn(el, true, '导入中…');
        try {
          var mr = await API.tasks.migrate();
          toast('已导入 ' + (mr.added || 0) + ' 个单元，移除 ' + (mr.removed || 0) + ' 条旧任务');
          await loadAll();
          renderAll();
        } catch (err) {
          busyBtn(el, false);
          toast(err.message || '导入失败');
        }
        return;
      }
      if (act === 'open-lesson') {
        if (!id) { toast('这一条没有关联课程单元，去「课程」页挑一节开始'); return; }
        closeSheet();
        try { history.replaceState(null, '', '#lesson/' + id); } catch (err) { /* ignore */ }
        openReader(id);
        return;
      }
      if (act === 'close-reader') { closeReader(); return; }
      if (act === 'review-lesson') {
        if (!id) return;
        try { history.replaceState(null, '', '#lesson/' + id); } catch (err) { /* ignore */ }
        openReader(id, { scrollToQuiz: true });
        return;
      }
      if (act === 'lesson-next') {
        if (!id) { toast('已经是最后一节了'); return; }
        closeSheet();
        try { history.replaceState(null, '', '#lesson/' + id); } catch (err) { /* ignore */ }
        openReader(id, { resetScroll: true });
        return;
      }
      if (act === 'go-courses') {
        closeReader(true);
        go('courses');
        return;
      }
      if (act === 'mark-read') { markRead(); return; }
      if (act === 'copy') {
        var code = el.getAttribute('data-code') || '';
        try {
          await navigator.clipboard.writeText(code);
          toast('已复制');
        } catch (err) {
          toast('复制失败，请长按选择');
        }
        return;
      }
      if (act === 'quiz-pick') {
        if (!State.reader || State.reader.submitted) return;
        State.reader.answers[Number(el.getAttribute('data-q'))] = Number(el.getAttribute('data-o'));
        var box = $('#quizBox');
        if (box) box.innerHTML = quizHtml(State.lessonById[State.reader.lessonId], State.reader);
        return;
      }
      if (act === 'quiz-submit') { submitQuiz(); return; }
      if (act === 'quiz-reset') {
        State.reader.submitted = false;
        State.reader.answers = {};
        var b2 = $('#quizBox');
        if (b2) b2.innerHTML = quizHtml(State.lessonById[State.reader.lessonId], State.reader);
        return;
      }
      if (act === 'hint-next') {
        if (State.reader.hints < 3) State.reader.hints++;
        var ht = $('#hintTier');
        if (ht) ht.innerHTML = hintHtml(State.lessonById[State.reader.lessonId], State.reader);
        return;
      }
      if (act === 'lesson-note') {
        var rr = State.reader;
        if (!rr) return;
        var ls = State.lessonById[rr.lessonId];
        var tk = State.lessonTask[rr.lessonId];
        openNoteEditor(null, {
          stage: ls.stage, title: ls.title,
          oldProblem: '', mechanism: '', pitfalls: '',
          taskId: tk ? tk.id : null
        });
        return;
      }
      if (act === 'lesson-stuck') {
        var r3 = State.reader;
        if (!r3) return;
        var t3 = State.lessonTask[r3.lessonId];
        if (!t3) { toast('这一节缺少任务记录'); return; }
        openTaskStuckSheet(t3.id);
        return;
      }
      if (act === 'note-edit') {
        openNoteEditor(State.notes.filter(function (x) { return x.id === numId; })[0]);
        return;
      }
      if (act === 'stuck-edit') { openStuckEdit(numId); return; }
      if (act === 'stuck-close') { openStuckClose(numId); return; }
      if (act === 'stuck-note') { openStuckNote(numId); return; }
      if (act === 'stuck-reopen') {
        try {
          await API.stuck.reopen(numId);
          await loadAll(); renderAll(); toast('已保存');
        } catch (err) { toast(err.message || '操作失败'); }
        return;
      }
      if (act === 'edit-nickname') {
        var cur = (State.me && State.me.nickname) || '';
        var v = prompt('新的昵称（下次登录要用它）', cur);
        if (v == null) return;
        v = v.trim();
        if (!v || v === cur) return;
        try {
          State.me = await API.user.updateNickname(v);
          renderAll(); toast('已保存');
        } catch (err) { toast(err.message || '保存失败'); }
        return;
      }
      if (act === 'logout') { logout(); return; }
      if (act === 'local-restore') {
        var snap = readLocalSnapshot();
        if (!snap) { toast('这台设备上没有快照了'); return; }
        if (snap.userId && State.me && snap.userId !== State.me.id &&
            !confirm('这份快照属于「' + (snap.nickname || '另一个账号') + '」，\n确定把它导入到当前账号吗？')) return;
        try {
          var rr = await API.backup.import({
            tasks: snap.tasks, notes: snap.notes, checkins: snap.checkins, stuck: snap.stuck
          });
          await loadAll();
          renderAll();
          if (State.reader) renderReader();
          var cn = rr.counts || {};
          toast('已从本机快照恢复：进度 ' + ((cn.tasks || 0) + (cn.merged || 0)) +
            ' 条、笔记 ' + (cn.notes || 0) + ' 条、打卡 ' + (cn.checkins || 0) + ' 天');
        } catch (e) { toast(e.message || '恢复失败'); }
        return;
      }
      if (act === 'cloud-push') {
        if (!cloudUserKey()) { toast('重新登录一次才能启用云端同步'); return; }
        cloudPush(true);
        setTimeout(function () { toast(cloudStatText()); }, 1200);
        return;
      }
      if (act === 'cloud-restore') { cloudRestore(true); return; }
      if (act === 'import-backup') {
        var finp = $('#importFile');
        if (!finp) { toast('这个浏览器不支持导入，换一个试试'); return; }
        finp.value = '';
        finp.click();
        return;
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && State.me && !State.reader) refresh(true);
    });
    window.addEventListener('focus', function () {
      if (State.me && !State.reader) refresh(true);
    });
    window.addEventListener('online', function () { if (State.me) refresh(true); });
    window.addEventListener('hashchange', function () {
      if (!State.me) return;
      var h = (location.hash || '').replace('#', '');
      if (h.indexOf('lesson/') === 0) {
        var lid = h.split('/')[1];
        if (State.lessonById[lid] && (!State.reader || State.reader.lessonId !== lid)) openReader(lid);
      } else {
        if (State.reader) closeReader(true);
        go(VIEWS.indexOf(h) >= 0 ? h : 'dashboard', true);
      }
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && State.reader) closeReader();
    });
  }

  /* ================= 启动 ================= */

  async function boot() {
    bind();

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    }

    try {
      var me = await API.auth.me();
      if (me) {
        State.me = me;
        await enterApp();
      } else {
        showLogin();
      }
    } catch (err) {
      showLogin();
      if (err.status === 404) {
        // 404 在这里只有一个含义：当前环境只托管了静态文件，后端服务没在运行
        //（WorkBuddy 预览面板在找不到本地服务时就会退回纯静态托管）。
        showLoginError('当前是纯静态预览，后端服务没在运行（接口 404）。' +
          '请打开线上链接使用：https://agent-study-checklist.app.workbuddy.host/?sharecode=34Y2CNE65B');
      } else {
        showLoginError(err.message || '无法连接服务器');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
