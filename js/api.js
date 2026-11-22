/**
 * js/api.js — 数据访问层，按模块拆分，对应后端路由：
 *   /api/auth    /api/user    /api/tasks    /api/notes    /api/checkins    /api/stuck    /api/dashboard
 *
 * 所有数据都在服务器上，前端不做主存储，也不用 localStorage 存业务数据。
 */
(function () {
  'use strict';

  var STAGES = [
    { key: 'filter', name: '筛信息' },
    { key: 'decompose', name: '拆问题' },
    { key: 'explain', name: '讲清楚' },
    { key: 'apply', name: '用出来' }
  ];
  var STAGE_NAME = {};
  STAGES.forEach(function (s) { STAGE_NAME[s.key] = s.name; });

  async function request(path, options) {
    options = options || {};
    var init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {}
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    var res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      var netErr = new Error('连不上服务器，请检查网络后重试');
      netErr.offline = true;
      throw netErr;
    }
    var text = await res.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!res.ok) {
      var err = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  function item(res) { return res.item; }
  function items(res) { return res.items || []; }

  var API = {
    STAGES: STAGES,
    STAGE_NAME: STAGE_NAME,

    dateStr: function (d) {
      var p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    today: function () { return API.dateStr(new Date()); },
    daysBetween: function (iso) {
      if (!iso) return 0;
      return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
    },

    /* ---------- 身份 ---------- */
    auth: {
      me: async function () {
        try {
          var res = await request('/api/auth/me');
          return res.user || null;
        } catch (e) {
          if (e.status === 401) return null;
          throw e;
        }
      },
      login: function (nickname, pin) {
        return request('/api/auth/login', { method: 'POST', body: { nickname: nickname, pin: pin } });
      },
      logout: function () {
        return request('/api/auth/logout', { method: 'POST' });
      }
    },

    /* ---------- 用户 ---------- */
    user: {
      updateNickname: function (nickname) {
        return request('/api/user', { method: 'PATCH', body: { nickname: nickname } }).then(function (r) { return r.user; });
      }
    },

    /* ---------- 课程内容 ---------- */
    curriculum: {
      get: function () { return request('/api/curriculum'); }
    },

    /* ---------- 任务 / 单元进度 ---------- */
    tasks: {
      list: function () { return request('/api/tasks').then(items); },
      create: function (payload) { return request('/api/tasks', { method: 'POST', body: payload }).then(item); },
      update: function (id, patch) { return request('/api/tasks/' + id, { method: 'PATCH', body: patch }).then(item); },
      remove: function (id) { return request('/api/tasks/' + id, { method: 'DELETE' }); },
      /** 记录"已读 / 自测得分"，服务端判定是否算学完 */
      progress: function (id, patch) {
        return request('/api/tasks/' + id + '/progress', { method: 'POST', body: patch });
      },
      /** 旧版数据迁移：移除无课程任务，补齐 14 个课程单元任务 */
      migrate: function () { return request('/api/migrate', { method: 'POST' }); },
      /** 间隔复测：记录一次回测成绩，服务端排下一次复测日 */
      review: function (id, payload) {
        return request('/api/tasks/' + id + '/review', { method: 'POST', body: payload });
      }
    },

    /* ---------- 笔记 ---------- */
    notes: {
      list: function () { return request('/api/notes').then(items); },
      create: function (payload) { return request('/api/notes', { method: 'POST', body: payload }).then(item); },
      update: function (id, patch) { return request('/api/notes/' + id, { method: 'PATCH', body: patch }).then(item); },
      remove: function (id) { return request('/api/notes/' + id, { method: 'DELETE' }); }
    },

    /* ---------- 打卡 ---------- */
    checkins: {
      list: function () { return request('/api/checkins').then(items); },
      save: function (date, stage, note) {
        return request('/api/checkins', {
          method: 'POST',
          body: { date: date, stage: stage, note: note }
        }).then(item);
      }
    },

    /* ---------- 卡点队列 ---------- */
    stuck: {
      list: function () { return request('/api/stuck').then(items); },
      open: function (payload) { return request('/api/stuck', { method: 'POST', body: payload }).then(item); },
      update: function (id, patch) { return request('/api/stuck/' + id, { method: 'PATCH', body: patch }).then(item); },
      close: function (id) { return request('/api/stuck/' + id, { method: 'PATCH', body: { status: 'closed' } }).then(item); },
      reopen: function (id) { return request('/api/stuck/' + id, { method: 'PATCH', body: { status: 'open' } }).then(item); }
    },

    /* ---------- 看板（服务端算好，前端只渲染） ---------- */
    dashboard: {
      get: function () { return request('/api/dashboard'); }
    },

    /* ---------- 备份：导出 / 导入 ---------- */
    exportUrl: '/api/export',
    backup: {
      import: function (payload) {
        return request('/api/backup/import', { method: 'POST', body: payload });
      }
    }
  };

  window.API = API;
})();
