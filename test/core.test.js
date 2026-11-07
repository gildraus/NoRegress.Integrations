'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');
const { startFakeApi, gradedLines, sleep } = require('./fake-api');

const CANARY = 'CANARY-7731';
const KEY = 'test-key-SECRET-123';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noregress-'));
}

function writeSuite(content, name = 'suite.json') {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

function makeCases(ids) {
  return ids.map((id) => ({
    id,
    input: `${CANARY} question`,
    actualOutput: `${CANARY} answer`,
    expectedOutput: `${CANARY} expected`,
    deterministicRules: [{ id: 'max-length', type: 'maxLength', value: 600 }, { id: 'no-canary', type: 'notContains', value: CANARY }],
    semanticRules: [{ id: 'polite', criterion: `${CANARY} must be polite` }],
  }));
}

async function run(api, suite, extra = {}) {
  const log = [];
  const result = await core.evaluateSuite(
    { suitePath: writeSuite(suite), serviceUrl: api.url, apiKey: KEY, ...extra },
    (line) => log.push(line),
  );
  return { result, log: log.join('\n') };
}

function expectSuiteError(content, pattern) {
  const file = typeof content === 'string' && content.startsWith('missing:') ? content.slice(8) : writeSuite(content);
  assert.throws(() => core.readSuite(file), (error) => error instanceof core.NoRegressError && pattern.test(error.message));
}

test('suite: valid file', () => {
  const suite = core.readSuite(writeSuite({ cases: makeCases(['a', 'b']) }));
  assert.equal(suite.cases.length, 2);
  assert.equal(suite.continueOnFailures, false);
});

test('suite: UTF-8 byte order mark is accepted', () => {
  const suite = core.readSuite(writeSuite(`﻿${JSON.stringify({ cases: makeCases(['a']) })}`));
  assert.equal(suite.cases.length, 1);
});

test('suite: missing file names the path', () => {
  const missing = path.join(tempDir(), 'nope.json');
  expectSuiteError(`missing:${missing}`, new RegExp(`not found: .*nope\\.json`));
});

test('suite: invalid JSON does not quote the file', () => {
  const file = writeSuite(`{"cases": [ ${CANARY} ]`);
  assert.throws(() => core.readSuite(file), (error) => /not valid JSON/.test(error.message) && !error.message.includes(CANARY));
});

test('suite: no cases, bad flag, bad case and missing id', () => {
  expectSuiteError({ cases: [] }, /non-empty array/);
  expectSuiteError([1, 2], /JSON object/);
  expectSuiteError({ cases: makeCases(['a']), continueOnFailures: 'yes' }, /continueOnFailures/);
  expectSuiteError({ cases: ['x'] }, /cases\[0\] must be an object/);
  expectSuiteError({ cases: [{ actualOutput: CANARY }] }, /cases\[0\] needs a non-empty string "id"/);
});

test('suite: duplicate id fails before any request and names the id', async () => {
  const api = await startFakeApi();
  try {
    await assert.rejects(run(api, { cases: makeCases(['refund-01', 'b', 'refund-01']) }), /"refund-01" is used more than once/);
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test('inputs: batch size and service URL are validated', () => {
  assert.equal(core.parseBatchSize(''), 50);
  assert.equal(core.parseBatchSize('7'), 7);
  assert.throws(() => core.parseBatchSize('0'), /at least 1/);
  assert.throws(() => core.parseBatchSize('ten'), /whole number/);
  assert.equal(core.parseServiceUrl(''), 'https://api.noregress.dev/evaluate');
  assert.equal(core.parseServiceUrl('http://localhost:5256/'), 'http://localhost:5256/evaluate');
  assert.throws(() => core.parseServiceUrl('ftp://x'), /http or https/);
  assert.throws(() => core.parseServiceUrl('not a url'), /http or https/);
});

test('batches: 120 cases go as 50, 50 and 20 in file order with the key and flag', async () => {
  const api = await startFakeApi();
  try {
    const ids = Array.from({ length: 120 }, (_, i) => `case-${String(i).padStart(3, '0')}`);
    const { result } = await run(api, { cases: makeCases(ids), continueOnFailures: true });
    assert.deepEqual(api.requests.map((r) => r.body.cases.length), [50, 50, 20]);
    assert.deepEqual(api.requests.flatMap((r) => r.body.cases.map((c) => c.id)), ids);
    for (const request of api.requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/evaluate');
      assert.equal(request.headers.authorization, `Bearer ${KEY}`);
      assert.equal(request.body.continueOnFailures, true);
    }
    assert.equal(result.counts.cases, 120);
    assert.equal(result.cases.length, 120);
  } finally {
    await api.close();
  }
});

test('batches: a small suite is one request, and batch size is an input', async () => {
  const api = await startFakeApi();
  try {
    await run(api, { cases: makeCases(['a', 'b', 'c']) });
    assert.equal(api.requests.length, 1);
    await run(api, { cases: makeCases(['a', 'b', 'c']) }, { batchSize: '2' });
    assert.deepEqual(api.requests.slice(1).map((r) => r.body.cases.length), [2, 1]);
  } finally {
    await api.close();
  }
});

test('outcome: one failed batch fails the run', async () => {
  const api = await startFakeApi();
  try {
    const { result } = await run(api, { cases: makeCases(['a', 'b', 'fail-c']) }, { batchSize: '2' });
    assert.equal(result.complete, true);
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.counts, { cases: 3, passed: 2, failed: 1, inconclusive: 0, notGraded: 0 });
  } finally {
    await api.close();
  }
});

test('outcome: continueOnFailures evaluates everything and passes', async () => {
  const api = await startFakeApi();
  try {
    const { result } = await run(api, { cases: makeCases(['a', 'fail-b', 'fail-c', 'd']), continueOnFailures: true }, { batchSize: '2' });
    assert.equal(result.outcome, 'passed');
    assert.equal(result.counts.failed, 2);
    assert.equal(result.cases.length, 4);
  } finally {
    await api.close();
  }
});

test('outcome: inconclusive fails, not graded does not', async () => {
  const api = await startFakeApi();
  try {
    assert.equal((await run(api, { cases: makeCases(['a', 'skip-b']) })).result.outcome, 'passed');
    const { result } = await run(api, { cases: makeCases(['a', 'inc-b']) });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.cases[1].status, 'inconclusive');
    assert.deepEqual(result.cases[1].errorRules, ['polite']);
  } finally {
    await api.close();
  }
});

async function incomplete(respond, pattern, cases = ['a', 'b', 'c', 'd']) {
  const api = await startFakeApi(respond);
  try {
    const { result } = await run(api, { cases: makeCases(cases) }, { batchSize: '2' });
    assert.equal(result.complete, false);
    assert.equal(result.outcome, 'failed');
    assert.match(result.error, pattern);
    assert.equal(api.requests.length, 1, 'no further batch is sent');
    return result;
  } finally {
    await api.close();
  }
}

test('incomplete: error line stops the run and shows the reason', async () => {
  const result = await incomplete((req, res, { body }) => {
    res.writeHead(200);
    res.write(`${JSON.stringify(gradedLines(body)[0])}\n`);
    res.end(`${JSON.stringify({ type: 'error', reason: 'The judge rejected the model name.' })}\n`);
  }, /stopped the evaluation in request 1 of 2.*judge rejected the model name/);
  assert.equal(result.cases.length, 1);
});

test('incomplete: stream without a summary', async () => {
  await incomplete((req, res, { body }) => {
    res.writeHead(200);
    res.end(`${JSON.stringify(gradedLines(body)[0])}\n`);
  }, /without a valid summary/);
});

test('incomplete: summary with the wrong case count', async () => {
  await incomplete((req, res) => {
    res.writeHead(200);
    res.end(`${JSON.stringify({ type: 'summary', cases: 1, passed: 1, failed: 0, inconclusive: 0, notGraded: 0, outcome: 'passed' })}\n`);
  }, /summarized 1 cases/);
});

test('incomplete: a line that is not JSON', async () => {
  await incomplete((req, res) => {
    res.writeHead(200);
    res.end('<html>proxy error</html>\n');
  }, /not valid JSON/);
});

test('incomplete: 401 says the key was rejected', async () => {
  await incomplete((req, res) => {
    res.writeHead(401);
    res.end();
  }, /rejected the API key \(HTTP 401\)/);
});

test('incomplete: 400 shows the validation message', async () => {
  await incomplete((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify({ errors: { 'cases[1].deterministicRules[0].type': ['Unknown type startsWith.'] } }));
  }, /HTTP 400.*cases\[1\]\.deterministicRules\[0\]\.type.*Unknown type startsWith/);
});

test('incomplete: other status codes', async () => {
  await incomplete((req, res) => {
    res.writeHead(502);
    res.end('Bad gateway');
  }, /HTTP 502/);
});

test('incomplete: connection closed mid-stream', async () => {
  await incomplete((req, res, { body }) => {
    res.writeHead(200);
    res.write(`${JSON.stringify(gradedLines(body)[0])}\n`);
    setTimeout(() => res.socket.destroy(), 20);
  }, /closed before the evaluation finished/);
});

test('incomplete: cannot connect', async () => {
  const { result } = await (async () => {
    const api = await startFakeApi();
    const url = api.url;
    await api.close();
    return run({ url }, { cases: makeCases(['a']) });
  })();
  assert.equal(result.complete, false);
  assert.match(result.error, /Cannot reach NoRegress/);
});

test('slow judge: waiting lines keep the request open past the idle limit and are logged', async () => {
  const api = await startFakeApi(async (req, res, { body }) => {
    res.writeHead(200);
    // 600 ms of waiting lines, each 50 ms apart, with a 200 ms idle limit: the scaled-down form of a
    // 6-minute judge load with lines every 30 s and a 5-minute limit.
    for (let elapsed = 1; elapsed <= 12; elapsed++) {
      res.write(`${JSON.stringify({ type: 'waiting', reason: 'The judge model is loading.', elapsedSeconds: elapsed * 30 })}\n`);
      await sleep(50);
    }
    for (const line of gradedLines(body)) {
      res.write(`${JSON.stringify(line)}\n`);
    }
    res.end();
  });
  try {
    const { result, log } = await run(api, { cases: makeCases(['a']) }, { idleTimeoutMs: 200 });
    assert.equal(result.complete, true);
    assert.match(log, /Waiting: The judge model is loading\. \(360s\)/);
  } finally {
    await api.close();
  }
});

test('slow judge: silence longer than the idle limit makes the run incomplete', async () => {
  const api = await startFakeApi(async (req, res) => {
    res.writeHead(200);
    await sleep(400);
    res.end();
  });
  try {
    const { result } = await run(api, { cases: makeCases(['a']) }, { idleTimeoutMs: 100 });
    assert.equal(result.complete, false);
    assert.match(result.error, /sent nothing for/);
  } finally {
    await api.close();
  }
});

test('log: one line per case with ids only, then the counts', async () => {
  const api = await startFakeApi();
  try {
    const { log } = await run(api, { cases: makeCases(['refund-01', 'fail-refund-02']) });
    assert.match(log, /PASSED\s+refund-01 {2}score 1\.00 \/ threshold 0\.80/);
    assert.match(log, /FAILED\s+fail-refund-02 {2}score 0\.50 \/ threshold 0\.80 {2}\(failed rules: max-length, polite\)/);
    assert.match(log, /2 cases: 1 passed, 1 failed, 0 inconclusive, 0 not graded\. Outcome: failed\./);
  } finally {
    await api.close();
  }
});

test('confidentiality: no case text, judge reason or key in log, result or JUnit', async () => {
  const api = await startFakeApi();
  try {
    const { result, log } = await run(api, { cases: makeCases(['a', 'fail-b', 'inc-c', 'skip-d']) });
    const everything = [log, JSON.stringify(result), core.toJUnit(result)].join('\n');
    assert.ok(api.requests[0].body.cases[0].actualOutput.includes(CANARY), 'the canary was sent to the API');
    assert.ok(!everything.includes(CANARY));
    assert.ok(!everything.includes(KEY));
  } finally {
    await api.close();
  }
});

test('JUnit: 8 passed, 1 failed, 1 not graded', async () => {
  const api = await startFakeApi();
  try {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'fail-i', 'skip-j'];
    const { result } = await run(api, { cases: makeCases(ids) });
    const xml = core.toJUnit(result);
    assert.match(xml, /<testsuites name="NoRegress" tests="10" failures="1" errors="0" skipped="1">/);
    assert.equal((xml.match(/<testcase /g) || []).length, 10);
    assert.match(xml, /<testcase classname="NoRegress.suite" name="a"\/>/);
    assert.match(xml, /name="fail-i">\n\s+<failure type="failed" message="Failed: score 0\.50, threshold 0\.80; failed rules: max-length, polite"\/>/);
    assert.match(xml, /name="skip-j">\n\s+<skipped /);
  } finally {
    await api.close();
  }
});

test('JUnit: an incomplete run keeps the cases so far and adds an error', async () => {
  const api = await startFakeApi((req, res, { body, index }) => {
    if (index === 0) {
      return false;
    }
    res.writeHead(200);
    res.end(`${JSON.stringify({ type: 'error', reason: 'Judge rejected the request.' })}\n`);
  });
  try {
    const { result } = await run(api, { cases: makeCases(['a', 'fail-b', 'c']) }, { batchSize: '2' });
    const xml = core.toJUnit(result);
    assert.match(xml, /tests="3" failures="1" errors="1" skipped="0"/);
    assert.match(xml, /name="\(evaluation incomplete\)">\n\s+<error type="incomplete" message="NoRegress stopped the evaluation in request 2 of 2/);
  } finally {
    await api.close();
  }
});

test('JUnit: ids are escaped', () => {
  const xml = core.toJUnit({
    suiteName: 's', complete: true, outcome: 'passed', error: null,
    counts: { cases: 1, passed: 1, failed: 0, inconclusive: 0, notGraded: 0 },
    cases: [{ id: 'a<&>"\'\u0001b', status: 'passed', score: 1, passThreshold: 0.8, failedRules: [], errorRules: [] }],
  });
  assert.match(xml, /name="a&lt;&amp;&gt;&quot;&apos;b"/);
});
