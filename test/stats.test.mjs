// test/stats.test.mjs — exact numbers for a fixed input set: mean, median,
// sample variance, stddev, min, max. n < 2 → null variance (never a false 0);
// nulls are excluded from the mean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toNumbers, mean, median, sampleVariance, stddev, minValue, maxValue, summarize,
} from '../lib/stats.js';

const approx = (a, b) => Math.abs(a - b) < 1e-9;

test('fixed set: [10,20,30,40,50] gives exact mean/median/variance/std/min/max', () => {
  const xs = [10, 20, 30, 40, 50];
  assert.equal(mean(xs), 30);
  assert.equal(median(xs), 30);
  assert.equal(sampleVariance(xs), 250);
  assert.ok(approx(stddev(xs), Math.sqrt(250)));
  assert.equal(minValue(xs), 10);
  assert.equal(maxValue(xs), 50);
  const s = summarize(xs);
  assert.equal(s.n, 5);
  assert.equal(s.mean, 30);
  assert.equal(s.median, 30);
  assert.equal(s.variance, 250);
  assert.ok(approx(s.stddev, Math.sqrt(250)));
  assert.equal(s.min, 10);
  assert.equal(s.max, 50);
});

test('even count: [1,2,3,4] — median is the mean of the two middle values', () => {
  const xs = [1, 2, 3, 4];
  assert.equal(median(xs), 2.5);
  assert.equal(mean(xs), 2.5);
  assert.ok(approx(sampleVariance(xs), 5 / 3));
  assert.ok(approx(stddev(xs), Math.sqrt(5 / 3)));
});

test('odd count with unsorted input: median finds the middle after sorting', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([9, 9, 9]), 9);
});

test('a single run has null variance and stddev — never a false 0', () => {
  const s = summarize([7]);
  assert.equal(s.n, 1);
  assert.equal(s.mean, 7);
  assert.equal(s.median, 7);
  assert.equal(s.variance, null);
  assert.equal(s.stddev, null);
  assert.equal(s.min, 7);
  assert.equal(s.max, 7);
});

test('an empty list yields nulls and n=0', () => {
  const s = summarize([]);
  assert.deepEqual(s, { n: 0, mean: null, median: null, variance: null, stddev: null, min: null, max: null });
});

test('nulls, undefined, NaN and Infinity are excluded, never averaged as 0', () => {
  const xs = [1, null, 3, undefined, NaN, Infinity, 5];
  assert.deepEqual(toNumbers(xs), [1, 3, 5]);
  assert.equal(mean(xs), 3);
  assert.equal(median(xs), 3);
  assert.equal(sampleVariance(xs), 4);
  assert.ok(approx(stddev(xs), 2));
  assert.equal(minValue(xs), 1);
  assert.equal(maxValue(xs), 5);
  assert.equal(summarize(xs).n, 3);
});

test('an unreachable-board null score does not drag the group mean down', () => {
  const scores = [1, 0.5, null, 1];
  assert.equal(mean(scores), 2.5 / 3);
  assert.ok(approx(mean(scores), 0.8333333333333333));
  assert.equal(summarize(scores).n, 3);
});

test('summarize never mutates the input', () => {
  const xs = [30, 10, 20];
  summarize(xs);
  assert.deepEqual(xs, [30, 10, 20]);
});