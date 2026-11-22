/**
 * content/index.js — 课程装配
 * 顺序即学习顺序：L1→L14。stage 决定它落在四阶段的哪一格。
 */
'use strict';

const STAGES = [
  { key: 'filter', name: '筛信息', goal: '建立模型能力的边界感，不再被流畅的胡说骗到' },
  { key: 'decompose', name: '拆问题', goal: '把模糊需求拆成能跑的最小链路' },
  { key: 'explain', name: '讲清楚', goal: '把"好像懂了"变成能讲给别人听的机制' },
  { key: 'apply', name: '用出来', goal: '交付一个能跑、能被追问的作品' }
];

const lessons = [].concat(
  require('./stage1'),
  require('./stage2'),
  require('./stage3'),
  require('./stage4')
);

// 计入"已跑通案例数"的单元
const CASE_IDS = ['L5', 'L6', 'L7', 'L12'];

// 正文审校状态挂在每个单元上（唯一事实源在 review.js）
const REVIEW = require('./review');

const byId = {};
lessons.forEach((l) => {
  l.review = REVIEW[l.id] || { level: 'none', at: null, by: null, pending: [] };
  byId[l.id] = l;
});

module.exports = { STAGES, lessons, byId, CASE_IDS, REVIEW };
