import assert from 'node:assert/strict';
import {
  DEFAULT_FIT_PROFILE,
  canonicalJobUrl,
  decorateJobsWithFit,
  deriveRuleFacts,
  jobTitleSimilarity,
  mergeJobDuplicates,
  normalizeJobTitle,
  scoreJobFit,
} from './jobs-intelligence.mjs';
import { DEFAULT_DIRECTIONS, DEFAULT_NON_TECH } from './jobs.mjs';
import { buildSearchQueries, candidateAllowed } from './jobs-discovery.mjs';

assert.equal(normalizeJobTitle('多模态大模型算法工程师（实习）'), '多模态大模型算法');
assert.ok(jobTitleSimilarity(
  '多模态大模型算法实习生',
  '多模态大模型算法工程师（实习）',
) >= 0.88);
assert.equal(
  canonicalJobUrl('https://jobs.example.com/a?utm_source=x&id=7&recomId=9#top'),
  'https://jobs.example.com/a?id=7#top',
);

const frontend = {
  id: 'frontend:1',
  title: '企业级事业部-前端研发实习生',
  company: '滴滴',
  city: '成都',
  jd: '负责前端页面开发与性能优化，参与数据存储和调度平台建设',
  requirement: 'React TypeScript',
};
const frontendFacts = deriveRuleFacts(frontend, {
  directions: DEFAULT_DIRECTIONS,
  nonTechKeywords: DEFAULT_NON_TECH,
});
assert.deepEqual(frontendFacts.tags, ['软件开发']);
assert.equal(frontendFacts.isTechnical, true);

const multimodal = {
  id: 'ml:1',
  title: '多模态大模型算法实习生',
  company: '斑马',
  city: '成都',
  jd: '多模态视觉语言模型、视觉 token 压缩、模型量化与 vLLM 推理优化',
  requirement: 'PyTorch CUDA',
  tags: ['大模型', 'AI Infra'],
  semantic: { isTechnical: true, primaryDirection: '大模型', highlights: [], risks: [] },
  salaryDailyMin: 300,
};
const frontendScored = scoreJobFit({
  ...frontend,
  tags: frontendFacts.tags,
  semantic: { ...frontendFacts, highlights: [], risks: [] },
}, DEFAULT_FIT_PROFILE);
const multimodalScored = scoreJobFit(multimodal, DEFAULT_FIT_PROFILE);
assert.ok(multimodalScored.fitScore > frontendScored.fitScore);
assert.ok(multimodalScored.fitScore >= 80);
assert.ok(frontendScored.fitScore < 45);

const merged = mergeJobDuplicates([
  {
    id: 'aggregate:1',
    company: '斑马',
    title: '多模态大模型算法实习生',
    city: '成都',
    url: 'https://example.com/a?utm_source=aggregate',
    source: '实习僧',
    tags: ['大模型'],
  },
  {
    id: 'web:1',
    company: '斑马',
    title: '多模态大模型算法工程师（实习）',
    city: '成都',
    url: 'https://example.com/b',
    source: '网页发现 · 招聘官网',
    salary: '300-400/天',
    tags: ['AI Infra'],
  },
]);
assert.equal(merged.duplicates, 1);
assert.equal(merged.items.length, 1);
assert.equal(merged.items[0].id, 'aggregate:1');
assert.equal(merged.items[0].salary, '300-400/天');
assert.deepEqual(merged.items[0].tags.sort(), ['AI Infra', '大模型'].sort());

const fitted = decorateJobsWithFit([multimodal], DEFAULT_FIT_PROFILE);
assert.equal(fitted[0].fitScore, multimodalScored.fitScore);
assert.ok(fitted[0].fitReasons.length > 0);

const queries = buildSearchQueries('成都', { maxQueries: 3 });
assert.equal(queries.length, 3);
assert.ok(queries.every((query) => query.includes('成都')));
assert.equal(candidateAllowed({
  title: '成都多模态算法实习生',
  url: 'https://example.com/job',
  summary: '招聘大模型算法实习生，工作地点成都',
  rerank_score: 2,
  authority: 3,
}, {}), true);
assert.equal(candidateAllowed({
  title: '大模型课程介绍',
  url: 'https://example.com/course',
  summary: '在线课程和题库',
  rerank_score: 2,
  authority: 3,
}, {}), false);

console.log('jobs intelligence tests: ok');
