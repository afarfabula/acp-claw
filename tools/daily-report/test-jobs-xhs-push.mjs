import assert from 'node:assert/strict';
import {
  classifyInterview,
  classifyOpportunity,
  detectBigCompany,
  detectDirections,
  extractInterviewQuestions,
  parseNoteDate,
  pickQuestionHighlights,
  renderJobsPushMessage,
} from './jobs-xhs-push.mjs';

const now = new Date('2026-11-18T12:00:00Z');

assert.equal(parseNoteDate('5天前', now), '2026-11-13');
assert.equal(parseNoteDate('昨天 21:10', now), '2026-11-17');
assert.equal(parseNoteDate('11-10 四川', now), '2026-11-10');
assert.equal(parseNoteDate('2025-09-09', now), '2025-09-09');

const chengdu = classifyOpportunity({
  title: '成都春熙路 AI Agent Startup 找同频 Intern',
  desc: '我们在成都，一家做 Agent 的初创公司，支持 remote。投递 a@example.com',
  dateText: '10-22 四川',
}, { now });
assert.equal(chengdu.include, true);
assert.equal(chengdu.category, 'chengdu');
assert.equal(chengdu.remote, true);
assert.equal(chengdu.email, 'a@example.com');
assert.deepEqual(chengdu.directions, ['大模型/Agent']);

const remote = classifyOpportunity({
  title: '远程 AI Infra 研发实习生',
  desc: '负责 vLLM 推理优化和 CUDA kernel，全程远程，不限城市，投递 hr@example.com',
  dateText: '5天前',
}, { now });
assert.equal(remote.include, true);
assert.equal(remote.category, 'remote');
assert.deepEqual(remote.directions, ['AI Infra']);

const embodied = classifyOpportunity({
  title: '成都具身智能算法实习生',
  desc: '做 VLA、机器人操作和仿真环境，工作地点成都，投递 robot@example.com',
  dateText: '今天',
}, { now });
assert.equal(embodied.include, true);
assert.deepEqual(embodied.directions.sort(), ['大模型/Agent', '具身智能'].sort());

assert.equal(classifyOpportunity({
  title: '北京 AI 初创招实习',
  desc: '必须线下，工作地点北京',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: '成都初创招实习生',
  desc: '已招满，谢谢关注',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: '成都不相关闲聊',
  desc: '这里是初创故事分享',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: '求助：能不能做 AI startup 实习',
  desc: '请问有没有成都或远程的初创实习？',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: 'AI Infra 实习简历求痛批',
  desc: '想找成都的推理优化实习，请问简历怎么改',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: '成都 AI 初创实训营正在招募学员',
  desc: '培训结束后可参与项目，工作地点成都',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: '成都高校具身智能实践',
  desc: '人形机器人数据采集、机械臂操作采集，工作地点成都',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: '成都大模型公司招内容运营实习生',
  desc: '负责小红书账号和短视频内容，工作地点成都',
  dateText: '今天',
}, { now }).include, false);

assert.equal(classifyOpportunity({
  title: '成都初创招实习生',
  desc: '负责日常行政和商务对接，工作地点成都',
  dateText: '今天',
}, { now }).include, false);

assert.deepEqual(detectDirections('LLM 后训练，GRPO，vLLM 推理部署'), ['大模型/Agent', 'AI Infra']);
assert.equal(detectBigCompany('字节跳动成都大模型实习')?.name, '字节跳动');
assert.equal(detectBigCompany('腾讯混元团队')?.name, '腾讯');
assert.equal(detectBigCompany('某普通创业公司')?.name, undefined);

const interviewQuestions = extractInterviewQuestions(`
一面：
1. 讲讲 PagedAttention 如何降低 KV Cache 显存？
2. GRPO 和 PPO 的区别是什么？
3. 手撕一个 top-k kernel
投递邮箱 test@example.com
`);
assert.equal(interviewQuestions.length, 3);
assert.match(interviewQuestions[0], /PagedAttention/);

const interview = classifyInterview({
  title: '字节大模型实习面经',
  desc: `
一面：
1. 讲讲 PagedAttention 如何降低 KV Cache 显存？
2. GRPO 和 PPO 的区别是什么？
3. 手撕一个 top-k kernel
`,
  author: '字节员工',
  dateText: '2天前',
  url: 'https://www.xiaohongshu.com/explore/interview',
}, { now });
assert.equal(interview.include, true);
assert.equal(interview.company, '字节跳动');
assert.match(interview.directions.join('/'), /AI Infra/);

const alibabaInterview = classifyInterview({
  title: '阿里大模型算法面经',
  desc: '面试中也比较了字节和腾讯的训练方案。GRPO 和 PPO 有什么区别？',
  author: '求职者',
  dateText: '今天',
}, { now });
assert.equal(alibabaInterview.company, '阿里巴巴');

const highlights = pickQuestionHighlights([
  { company: '字节跳动', sourceUrl: 'a', question: 'a1' },
  { company: '字节跳动', sourceUrl: 'a', question: 'a2' },
  { company: '字节跳动', sourceUrl: 'a', question: 'a3' },
  { company: '腾讯', sourceUrl: 'b', question: 'b1' },
  { company: '京东', sourceUrl: 'c', question: 'c1' },
  { company: '阿里巴巴', sourceUrl: 'd', question: 'd1' },
  { company: '商汤', sourceUrl: 'e', question: 'e1' },
  { company: 'OPPO', sourceUrl: 'f', question: 'f1' },
], 8);
assert.equal(new Set(highlights.map((item) => item.company)).size, 6);

const message = renderJobsPushMessage([
  {
    category: 'chengdu',
    title: '成都 AI Agent Startup 实习生',
    desc: '做 Agent 产品，支持 remote。',
    remote: true,
    technical: true,
    directions: ['大模型/Agent'],
    salary: '300-500/天',
    email: 'a@example.com',
    url: 'https://www.xiaohongshu.com/explore/abc',
  },
  {
    category: 'remote',
    title: '远程 AI 研发实习生',
    desc: '全程远程。',
    remote: true,
    technical: true,
    directions: ['AI Infra'],
    salary: '',
    email: '',
    url: 'https://www.xiaohongshu.com/explore/def',
  },
], {
  now,
  interviewQuestions: [{
    company: '字节跳动',
    directions: ['AI Infra'],
    question: '讲讲 PagedAttention 如何降低 KV Cache 显存？',
    sourceTitle: '字节大模型实习面经',
    sourceUrl: 'https://www.xiaohongshu.com/explore/interview',
  }],
  interviewBankUrl: 'https://example.feishu.cn/docx/bank',
});
assert.match(message, /📍 成都/);
assert.match(message, /🌐 Remote/);
assert.match(message, /支持远程/);
assert.match(message, /大厂优先技术实习/);
assert.match(message, /大模型\/Agent/);
assert.match(message, /AI Infra/);
assert.match(message, /新增大厂面经考点/);
assert.match(message, /PagedAttention/);
assert.match(message, /投递：a@example\.com/);
assert.match(message, /查看原帖私信\/评论区/);

console.log('jobs-xhs-push tests passed');
