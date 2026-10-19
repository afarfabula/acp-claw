import assert from 'node:assert/strict';
import {
  estimateInternshipSalary,
  extractSalaryFromText,
  parseDailySalary,
  sourceSalary,
} from './jobs.mjs';

assert.deepEqual(parseDailySalary('300-500/天'), { min: 300, max: 500 });
assert.deepEqual(parseDailySalary('4.5K-7.5K/月'), { min: 206.9, max: 344.8 });
assert.deepEqual(parseDailySalary('每月 6000 元'), { min: 275.9, max: 275.9 });
assert.deepEqual(parseDailySalary('年薪30-50万'), { min: 1149.4, max: 1915.7 });
assert.deepEqual(parseDailySalary('20-30元/小时'), { min: 160, max: 240 });
assert.equal(parseDailySalary('实习3个月'), null);
assert.equal(extractSalaryFromText('实习3个月，日薪300-400元/天'), '日薪300-400元/天');
assert.equal(extractSalaryFromText('实习3个月，负责算法开发'), '');
assert.equal(sourceSalary({ minSalary: 30, maxSalary: 50 }), '30-50K/月');

const estimated = estimateInternshipSalary({
  companyKey: 'bytedance',
  tags: ['软件开发'],
});
assert.equal(estimated.salary, '¥300-400/天');
assert.equal(estimated.salarySource, 'benchmark');

console.log('jobs salary tests: ok');
