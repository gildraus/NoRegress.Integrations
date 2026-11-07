'use strict';

// The shared core of the GitHub Action and the Azure DevOps task. It reads a suite file, sends its cases to
// NoRegress (POST /evaluate) in batches, adds up the results and writes a JUnit file. The two adapters
// (github.js, azure.js) only translate inputs and outputs for their CI system.
//
// Customer data is confidential: nothing here prints, writes or returns case text (inputs, outputs,
// expected outputs, criteria, rule values) or judge reasons. Only ids, statuses, scores and counts.
// Uses only Node's standard library, so nothing has to be installed or bundled.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_SERVICE_URL = 'https://api.noregress.dev';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_JUNIT_FILE = 'noregress-results.xml';
// The API sends a line at least every 30 seconds; ten times that without a line means it is gone.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ERROR_BODY_CHARS = 2000;

/** An expected failure with a message that is safe to show: no case text, no key. */
class NoRegressError extends Error {}

function readSuite(suitePath) {
  if (!suitePath) {
    throw new NoRegressError('suite is required: the path to a suite file.');
  }
  let text;
  try {
    text = fs.readFileSync(suitePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new NoRegressError(`Suite file not found: ${suitePath}`);
    }
    throw new NoRegressError(`Suite file ${suitePath} cannot be read (${error.code || 'unknown error'}).`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // The parser's own message quotes the file's text, so it is not shown.
    throw new NoRegressError(`Suite file ${suitePath} is not valid JSON.`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new NoRegressError(`Suite file ${suitePath} must be a JSON object with a "cases" array.`);
  }
  if (!Array.isArray(body.cases) || body.cases.length === 0) {
    throw new NoRegressError(`Suite file ${suitePath}: "cases" must be a non-empty array.`);
  }
  if (body.continueOnFailures !== undefined && typeof body.continueOnFailures !== 'boolean') {
    throw new NoRegressError(`Suite file ${suitePath}: "continueOnFailures" must be true or false.`);
  }
  const seen = new Set();
  body.cases.forEach((testCase, index) => {
    if (testCase === null || typeof testCase !== 'object' || Array.isArray(testCase)) {
      throw new NoRegressError(`Suite file ${suitePath}: cases[${index}] must be an object.`);
    }
    if (typeof testCase.id !== 'string' || testCase.id.trim() === '') {
      throw new NoRegressError(`Suite file ${suitePath}: cases[${index}] needs a non-empty string "id".`);
    }
    if (seen.has(testCase.id)) {
      throw new NoRegressError(`Suite file ${suitePath}: case id "${testCase.id}" is used more than once.`);
    }
    seen.add(testCase.id);
  });
  return { cases: body.cases, continueOnFailures: body.continueOnFailures === true };
}

function parseServiceUrl(value) {
  const text = value || DEFAULT_SERVICE_URL;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new NoRegressError(`service URL must be an absolute http or https URL, got "${text}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new NoRegressError(`service URL must be an absolute http or https URL, got "${text}".`);
  }
  return `${text.replace(/\/+$/, '')}/evaluate`;
}

function parseBatchSize(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_BATCH_SIZE;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new NoRegressError(`batch size must be a whole number of at least 1, got "${text}".`);
  }
  return Number(text);
}

/** Sends one request and calls onLine for each line of the streamed body. Resolves with the HTTP status. */
function postBatch({ url, apiKey, body, idleTimeoutMs, onLine }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      request.destroy();
    };
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': payload.length,
          'User-Agent': 'NoRegress-CI',
        },
      },
      (response) => {
        response.setEncoding('utf8');
        if (response.statusCode !== 200) {
          let text = '';
          response.on('data', (chunk) => {
            if (text.length < MAX_ERROR_BODY_CHARS) {
              text += chunk;
            }
          });
          response.on('end', () => done({ status: response.statusCode, body: text.slice(0, MAX_ERROR_BODY_CHARS) }));
          response.on('error', fail);
          return;
        }
        let buffer = '';
        const emit = (line) => {
          try {
            onLine(line);
          } catch (error) {
            fail(error);
          }
        };
        response.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while (!settled && (index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            emit(line);
          }
        });
        const closedEarly = () => fail(new NoRegressError('The connection to NoRegress closed before the evaluation finished.'));
        response.on('end', () => {
          if (buffer.trim() !== '') {
            emit(buffer);
          }
          done({ status: 200 });
        });
        response.on('error', closedEarly);
        response.on('close', () => {
          if (!response.complete) {
            closedEarly();
          }
        });
      },
    );
    request.setTimeout(idleTimeoutMs, () => {
      const minutes = Math.round((idleTimeoutMs / 60000) * 10) / 10;
      fail(new NoRegressError(`NoRegress sent nothing for ${minutes} minutes; the evaluation is incomplete.`));
    });
    request.on('error', (error) => {
      fail(error instanceof NoRegressError ? error : new NoRegressError(`Cannot reach NoRegress at ${target.origin}: ${error.code || error.message}.`));
    });
    request.end(payload);
  });
}

function ruleIds(line, status) {
  const sections = [line.deterministic, line.semantic];
  const ids = [];
  for (const section of sections) {
    const results = section && Array.isArray(section.results) ? section.results : [];
    for (const rule of results) {
      if (rule && rule.status === status && typeof rule.id === 'string') {
        ids.push(rule.id);
      }
    }
  }
  return ids;
}

/** Keeps only what may be shown: id, status, score, threshold and rule ids. */
function toCaseResult(line) {
  const errorRules = ruleIds(line, 'error');
  let status;
  if (line.passed === true) {
    status = 'passed';
  } else if (line.passed === false) {
    status = 'failed';
  } else {
    status = errorRules.length > 0 ? 'inconclusive' : 'notGraded';
  }
  return {
    id: String(line.id),
    status,
    score: typeof line.score === 'number' ? line.score : null,
    passThreshold: typeof line.passThreshold === 'number' ? line.passThreshold : null,
    failedRules: ruleIds(line, 'failed'),
    errorRules,
  };
}

const STATUS_LABELS = {
  passed: 'PASSED',
  failed: 'FAILED',
  inconclusive: 'INCONCLUSIVE',
  notGraded: 'NOT GRADED',
};

function formatNumber(value) {
  return value === null ? 'none' : value.toFixed(2);
}

function describeRules(result) {
  const parts = [];
  if (result.failedRules.length > 0) {
    parts.push(`failed rules: ${result.failedRules.join(', ')}`);
  }
  if (result.errorRules.length > 0) {
    parts.push(`rules with errors: ${result.errorRules.join(', ')}`);
  }
  return parts.join('; ');
}

function formatCaseLine(result) {
  const rules = describeRules(result);
  return `${STATUS_LABELS[result.status].padEnd(12)} ${result.id}  score ${formatNumber(result.score)} / threshold ${formatNumber(result.passThreshold)}${rules ? `  (${rules})` : ''}`;
}

function formatCounts(counts) {
  return `${counts.cases} cases: ${counts.passed} passed, ${counts.failed} failed, ${counts.inconclusive} inconclusive, ${counts.notGraded} not graded`;
}

function httpError(response, batchLabel) {
  if (response.status === 401) {
    return new NoRegressError(`NoRegress rejected the API key (HTTP 401) for ${batchLabel}. Check the API key input and the secret it comes from.`);
  }
  if (response.status === 400) {
    // Validation errors name request fields and rule ids, never the evaluated text.
    const indexNote = 'Case indexes in the message count from the start of this request.';
    return new NoRegressError(`NoRegress rejected ${batchLabel} (HTTP 400). ${indexNote} ${response.body}`.trim());
  }
  return new NoRegressError(`NoRegress returned HTTP ${response.status} for ${batchLabel}; the evaluation is incomplete.`);
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

async function runBatch({ url, apiKey, cases, continueOnFailures, idleTimeoutMs, batchLabel, log, onCase }) {
  let summary = null;
  let errorLine = null;
  const response = await postBatch({
    url,
    apiKey,
    body: { continueOnFailures, cases },
    idleTimeoutMs,
    onLine: (raw) => {
      if (raw.trim() === '') {
        return;
      }
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        throw new NoRegressError(`NoRegress sent a line that is not valid JSON for ${batchLabel}; the evaluation is incomplete.`);
      }
      switch (line && line.type) {
        case 'case':
          onCase(toCaseResult(line));
          break;
        case 'waiting':
          log(`Waiting: ${line.reason} (${line.elapsedSeconds}s)`);
          break;
        case 'summary':
          summary = line;
          break;
        case 'error':
          errorLine = line;
          break;
        default:
          // Unknown line types are ignored so a newer API does not break older integrations.
          break;
      }
    },
  });
  if (response.status !== 200) {
    throw httpError(response, batchLabel);
  }
  if (errorLine) {
    throw new NoRegressError(`NoRegress stopped the evaluation in ${batchLabel}: ${errorLine.reason}`);
  }
  if (
    !summary ||
    !['cases', 'passed', 'failed', 'inconclusive', 'notGraded'].every((key) => isCount(summary[key])) ||
    (summary.outcome !== 'passed' && summary.outcome !== 'failed')
  ) {
    throw new NoRegressError(`NoRegress ended ${batchLabel} without a valid summary; the evaluation is incomplete.`);
  }
  if (summary.cases !== cases.length) {
    throw new NoRegressError(`NoRegress summarized ${summary.cases} cases for ${batchLabel}, which had ${cases.length}; the evaluation is incomplete.`);
  }
  return summary;
}

/**
 * Evaluates a suite. Suite and input errors throw NoRegressError before any request. Errors during the run
 * do not throw: they come back as result.error with result.complete false and outcome "failed", so the
 * caller can still write the JUnit file and outputs for the cases evaluated so far.
 */
async function evaluateSuite(options, log = console.log) {
  const url = parseServiceUrl(options.serviceUrl);
  const batchSize = parseBatchSize(options.batchSize);
  const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
  if (!options.apiKey) {
    throw new NoRegressError('API key is required. Pass it from a secret.');
  }
  const suite = readSuite(options.suitePath);
  const batches = [];
  for (let start = 0; start < suite.cases.length; start += batchSize) {
    batches.push(suite.cases.slice(start, start + batchSize));
  }
  const result = {
    suiteName: path.basename(options.suitePath).replace(/\.json$/i, ''),
    complete: false,
    outcome: 'failed',
    error: null,
    counts: { cases: 0, passed: 0, failed: 0, inconclusive: 0, notGraded: 0 },
    cases: [],
  };
  log(`NoRegress: evaluating ${suite.cases.length} cases from ${options.suitePath} in ${batches.length} request(s) of at most ${batchSize} cases.`);

  let anyFailed = false;
  try {
    let first = 1;
    for (let index = 0; index < batches.length; index++) {
      const cases = batches[index];
      const batchLabel = `request ${index + 1} of ${batches.length} (cases ${first} to ${first + cases.length - 1})`;
      const summary = await runBatch({
        url,
        apiKey: options.apiKey,
        cases,
        continueOnFailures: suite.continueOnFailures,
        idleTimeoutMs,
        batchLabel,
        log,
        onCase: (caseResult) => {
          result.cases.push(caseResult);
          log(formatCaseLine(caseResult));
        },
      });
      for (const key of Object.keys(result.counts)) {
        result.counts[key] += summary[key];
      }
      if (summary.outcome === 'failed') {
        anyFailed = true;
      }
      first += cases.length;
    }
    result.complete = true;
    result.outcome = anyFailed ? 'failed' : 'passed';
  } catch (error) {
    result.error = error instanceof NoRegressError ? error.message : `Unexpected error: ${error.message}`;
    result.outcome = 'failed';
  }

  if (result.complete) {
    log(`NoRegress: ${formatCounts(result.counts)}. Outcome: ${result.outcome}.`);
  } else {
    log(`NoRegress: the evaluation is incomplete after ${result.cases.length} of ${suite.cases.length} cases. Outcome: failed.`);
  }
  return result;
}

// XML 1.0 allows only these characters; anything else is dropped from names and messages.
function escapeXml(value) {
  return String(value)
    .replace(/[^\u0009\u000A\u000D -퟿-�]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function caseMessage(result) {
  const rules = describeRules(result);
  return `score ${formatNumber(result.score)}, threshold ${formatNumber(result.passThreshold)}${rules ? `; ${rules}` : ''}`;
}

/** JUnit XML for a run: one test case per case, plus one error test case when the run is incomplete. */
function toJUnit(result) {
  const failures = result.cases.filter((c) => c.status === 'failed' || c.status === 'inconclusive').length;
  const skipped = result.cases.filter((c) => c.status === 'notGraded').length;
  const errors = result.complete ? 0 : 1;
  const tests = result.cases.length + errors;
  const className = escapeXml(`NoRegress.${result.suiteName}`);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="NoRegress" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}">`,
    `  <testsuite name="${escapeXml(`NoRegress ${result.suiteName}`)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}">`,
  ];
  for (const c of result.cases) {
    const open = `    <testcase classname="${className}" name="${escapeXml(c.id)}"`;
    if (c.status === 'passed') {
      lines.push(`${open}/>`);
    } else if (c.status === 'notGraded') {
      lines.push(`${open}>`, '      <skipped message="Not graded: every rule was skipped."/>', '    </testcase>');
    } else {
      const type = c.status === 'failed' ? 'failed' : 'inconclusive';
      const label = c.status === 'failed' ? 'Failed' : 'Inconclusive';
      lines.push(`${open}>`, `      <failure type="${type}" message="${escapeXml(`${label}: ${caseMessage(c)}`)}"/>`, '    </testcase>');
    }
  }
  if (!result.complete) {
    lines.push(
      `    <testcase classname="${className}" name="(evaluation incomplete)">`,
      `      <error type="incomplete" message="${escapeXml(result.error || 'The evaluation is incomplete.')}"/>`,
      '    </testcase>',
    );
  }
  lines.push('  </testsuite>', '</testsuites>', '');
  return lines.join('\n');
}

function writeJUnit(result, junitPath) {
  fs.mkdirSync(path.dirname(junitPath), { recursive: true });
  fs.writeFileSync(junitPath, toJUnit(result), 'utf8');
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_JUNIT_FILE,
  DEFAULT_SERVICE_URL,
  NoRegressError,
  evaluateSuite,
  formatCaseLine,
  formatCounts,
  parseBatchSize,
  parseServiceUrl,
  readSuite,
  toCaseResult,
  toJUnit,
  writeJUnit,
};
