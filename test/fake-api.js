'use strict';

// A fake NoRegress API on localhost. By default it grades each case by its id prefix:
// "fail-" failed, "inc-" inconclusive, "skip-" not graded, anything else passed.

const http = require('node:http');

function caseLine(testCase) {
  const id = testCase.id;
  const canary = 'CANARY-7731 judge reason quoting the output';
  if (id.startsWith('fail-')) {
    return {
      type: 'case', id, passed: false, score: 0.5, passThreshold: 0.8,
      deterministic: { results: [{ id: 'max-length', type: 'maxLength', status: 'failed', actual: 900 }] },
      semantic: { semanticEvaluation: 'enabled', judgeModel: 'fake', results: [{ id: 'polite', status: 'failed', reason: canary }, { id: 'english', status: 'passed' }] },
    };
  }
  if (id.startsWith('inc-')) {
    return {
      type: 'case', id, passed: null, score: null, passThreshold: 0.8,
      deterministic: { results: [] },
      semantic: { semanticEvaluation: 'enabled', judgeModel: 'fake', results: [{ id: 'polite', status: 'error', reason: canary }] },
    };
  }
  if (id.startsWith('skip-')) {
    return {
      type: 'case', id, passed: null, score: null, passThreshold: 0.8,
      deterministic: { results: [] },
      semantic: { semanticEvaluation: 'disabled', judgeModel: null, results: [{ id: 'polite', status: 'skipped' }] },
    };
  }
  return {
    type: 'case', id, passed: true, score: 1, passThreshold: 0.8,
    deterministic: { results: [{ id: 'max-length', type: 'maxLength', status: 'passed', actual: 120 }] },
    semantic: { semanticEvaluation: 'enabled', judgeModel: 'fake', results: [{ id: 'polite', status: 'passed' }] },
  };
}

function gradedLines(body) {
  const lines = body.cases.map(caseLine);
  const count = (predicate) => lines.filter(predicate).length;
  const failed = count((l) => l.passed === false);
  const inconclusive = count((l) => l.passed === null && l.semantic.results.some((r) => r.status === 'error'));
  const summary = {
    type: 'summary',
    cases: lines.length,
    passed: count((l) => l.passed === true),
    failed,
    inconclusive,
    notGraded: lines.length - count((l) => l.passed !== null) - inconclusive,
    outcome: body.continueOnFailures || failed + inconclusive === 0 ? 'passed' : 'failed',
  };
  return [...lines, summary];
}

/**
 * Starts the fake API. `respond(request, res, context)` may answer itself; return false to use the default
 * grading. The context has `body` (the parsed request) and `index` (0 for the first request).
 */
async function startFakeApi(respond = () => false) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (text += chunk));
    req.on('end', async () => {
      const body = JSON.parse(text);
      const context = { body, index: requests.length };
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const handled = await respond(req, res, context);
      if (handled === false) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        for (const line of gradedLines(body)) {
          res.write(`${JSON.stringify(line)}\n`);
        }
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { startFakeApi, gradedLines, sleep };
