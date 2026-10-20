import assert from 'node:assert/strict';
import { parseJdInternResponse } from './jobs.mjs';
import { renderJobsWeb } from './jobs-web.mjs';

const parsed = parseJdInternResponse({
  success: true,
  body: {
    totalNumber: 2,
    items: [
      {
        publishId: 4870,
        positionName: '移动端开发工程师',
        jobDirection: '技术方向',
        publishTime: 1709293170000,
        workContent: '负责移动端研发',
        qualification: '计算机相关专业',
        requirementVoList: [
          { workCity: '四川省-成都市' },
          { workCity: '北京市-北京市' },
          { workCity: '四川省-成都市' },
        ],
      },
      {
        publishId: 9999,
        positionName: '重复岗位',
        requirementVoList: [{ workCity: '北京市-北京市' }],
      },
    ],
  },
});

assert.equal(parsed.total, 2);
assert.equal(parsed.items.length, 2);
assert.equal(parsed.items[0].title, '移动端开发工程师');
assert.equal(parsed.items[0].city, '四川省-成都市/北京市-北京市');
assert.equal(parsed.items[0].source, '京东校招官网');
assert.match(parsed.items[0].url, /campus\.jd\.com/);
assert.equal(parsed.items.filter((it) => String(it.city).includes('成都')).length, 1);

const legacy = parseJdInternResponse({
  body: [{
    channelPositionVoList: [{
      publishId: 1,
      positionName: '算法实习生',
      jobDirection: 'TGT实习生',
      requirementVoList: [{ workCity: '四川省-成都市' }],
    }],
  }],
});
assert.equal(legacy.items.length, 1);
assert.equal(legacy.items[0].title, '算法实习生');

const html = renderJobsWeb({
  city: '成都',
  items: [],
  newItems: [],
  companies: [],
  filters: { technicalOnly: true, minDailySalary: 200 },
  officialSources: [
    {
      key: 'alibaba',
      name: '阿里巴巴',
      siteUrl: 'https://campus-talent.alibaba.com/campus/position',
      status: 'ok',
      fetched: 621,
      cityMatched: 0,
      included: 0,
      error: '',
    },
  ],
});
assert.match(html, /阿里巴巴官网 0（成都暂无）/);
assert.match(html, /大厂岗位仅采官网|岗位仅采官网/);

console.log('jobs official-source tests: ok');
