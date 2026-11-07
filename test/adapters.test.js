'use strict';

// Runs src/github.js and src/azure.js as the CI systems do: as a separate Node process with INPUT_*
// variables, against the fake API.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { startFakeApi } = require('./fake-api');

const CANARY = 'CANARY-7731';
const KEY = 'test-key-SECRET-123';
const ROOT = path.join(__dirname, '..');

function workspace(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noregress-ws-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  const suite = {
    cases: cases.map((id) => ({
      id,
      actualOutput: `${CANARY} answer`,
      deterministicRules: [{ id: 'max-length', type: 'maxLength', value: 600 }],
      semanticRules: [{ id: 'polite', criterion: `${CANARY} polite` }],
    })),
  };
  fs.writeFileSync(path.join(dir, 'tests', 'support-bot.json'), JSON.stringify(suite), 'utf8');
  return dir;
}

function runNode(script, env) {
  return new Promise((resolve) => {
    // Only what the CI system would pass, so a developer's INPUT_* or GITHUB_* variables cannot leak in.
    const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
    execFile(process.execPath, [path.join(ROOT, 'src', script)], { env: { ...base, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function runGitHub(api, ws, inputs = {}) {
  const outputFile = path.join(ws, 'github-output.txt');
  const summaryFile = path.join(ws, 'github-summary.md');
  fs.writeFileSync(outputFile, '');
  fs.writeFileSync(summaryFile, '');
  const run = await runNode('github.js', {
    GITHUB_WORKSPACE: ws,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    'INPUT_SUITE': 'tests/support-bot.json',
    'INPUT_API-KEY': KEY,
    'INPUT_SERVICE-URL': api.url,
    'INPUT_BATCH-SIZE': '2',
    'INPUT_JUNIT-FILE': 'out/github.xml',
    ...inputs,
  });
  const outputs = Object.fromEntries(
    fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  return { ...run, outputs, summary: fs.readFileSync(summaryFile, 'utf8') };
}

async function runAzure(api, ws, inputs = {}) {
  const run = await runNode('azure.js', {
    SYSTEM_DEFAULTWORKINGDIRECTORY: ws,
    INPUT_SUITE: 'tests/support-bot.json',
    INPUT_APIKEY: KEY,
    INPUT_SERVICEURL: api.url,
    INPUT_BATCHSIZE: '2',
    INPUT_JUNITFILE: 'out/azure.xml',
    ...inputs,
  });
  const outputs = {};
  for (const match of run.stdout.matchAll(/##vso\[task\.setvariable variable=([^;]+);isOutput=true;\](.*)/g)) {
    outputs[match[1]] = match[2].trim();
  }
  return { ...run, outputs };
}

// The mask and setsecret commands carry the key so the CI system can hide it; the runner never shows them.
function logWithoutMaskCommands(stdout) {
  return stdout.split(/\r?\n/).filter((line) => !line.startsWith('::add-mask::') && !line.startsWith('##vso[task.setsecret]')).join('\n');
}

test('GitHub: passing suite sets outputs, writes the summary and JUnit, exits 0', async () => {
  const api = await startFakeApi();
  const ws = workspace(['refund-01', 'refund-02', 'skip-03']);
  try {
    const run = await runGitHub(api, ws);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`::add-mask::${KEY}`));
    assert.deepEqual(run.outputs, {
      outcome: 'passed',
      cases: '3',
      'passed-cases': '2',
      'failed-cases': '0',
      'inconclusive-cases': '0',
      'not-graded-cases': '1',
      'junit-file': path.join(ws, 'out', 'github.xml'),
    });
    assert.match(run.summary, /## NoRegress: ✅ passed/);
    assert.match(run.summary, /\| `refund-01` \| ✅ passed \| 1\.00 \| 0\.80 \| {2}\|/);
    assert.ok(fs.existsSync(path.join(ws, 'out', 'github.xml')));
  } finally {
    await api.close();
  }
});

test('GitHub: failed suite exits 1 with an error annotation', async () => {
  const api = await startFakeApi();
  const ws = workspace(['refund-01', 'fail-refund-02']);
  try {
    const run = await runGitHub(api, ws);
    assert.equal(run.code, 1);
    assert.equal(run.outputs.outcome, 'failed');
    assert.match(run.stdout, /::error::NoRegress gate failed: 2 cases: 1 passed, 1 failed/);
    assert.match(run.summary, /\| `fail-refund-02` \| ❌ failed \| 0\.50 \| 0\.80 \| failed: max-length, failed: polite \|/);
  } finally {
    await api.close();
  }
});

test('GitHub: missing suite fails without calling the API', async () => {
  const api = await startFakeApi();
  const ws = workspace(['a']);
  try {
    const run = await runGitHub(api, ws, { INPUT_SUITE: 'tests/missing.json' });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /::error::Suite file not found: .*missing\.json/);
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test('Azure DevOps: passing suite sets output variables, publishes JUnit, succeeds', async () => {
  const api = await startFakeApi();
  const ws = workspace(['refund-01', 'refund-02', 'skip-03']);
  try {
    const run = await runAzure(api, ws);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`##vso\\[task\\.setsecret\\]${KEY}`));
    assert.deepEqual(run.outputs, {
      outcome: 'passed',
      cases: '3',
      passedCases: '2',
      failedCases: '0',
      inconclusiveCases: '0',
      notGradedCases: '1',
      junitFile: path.join(ws, 'out', 'azure.xml'),
    });
    const junit = path.join(ws, 'out', 'azure.xml').replace(/;/g, '%3B');
    assert.ok(run.stdout.includes(`##vso[results.publish type=JUnit;mergeResults=false;runTitle=NoRegress support-bot;resultFiles=${junit};]`));
    assert.match(run.stdout, /##vso\[task\.complete result=Succeeded;\]NoRegress gate passed/);
  } finally {
    await api.close();
  }
});

test('Azure DevOps: failed suite fails the task', async () => {
  const api = await startFakeApi();
  const ws = workspace(['refund-01', 'fail-refund-02']);
  try {
    const run = await runAzure(api, ws);
    assert.equal(run.code, 1);
    assert.equal(run.outputs.outcome, 'failed');
    assert.match(run.stdout, /##vso\[task\.logissue type=error;\]NoRegress gate failed/);
    assert.match(run.stdout, /##vso\[task\.complete result=Failed;\]NoRegress gate failed/);
  } finally {
    await api.close();
  }
});

test('Azure DevOps: 401 fails the task and says the key was rejected', async () => {
  const api = await startFakeApi((req, res) => {
    res.writeHead(401);
    res.end();
  });
  const ws = workspace(['a']);
  try {
    const run = await runAzure(api, ws);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /##vso\[task\.complete result=Failed;\]NoRegress rejected the API key/);
  } finally {
    await api.close();
  }
});

test('same result on both: requests, counts, outcome and JUnit are identical', async () => {
  const ids = ['a', 'fail-b', 'inc-c', 'skip-d', 'e'];
  const githubApi = await startFakeApi();
  const azureApi = await startFakeApi();
  const ws = workspace(ids);
  try {
    const github = await runGitHub(githubApi, ws);
    const azure = await runAzure(azureApi, ws);
    assert.deepEqual(githubApi.requests.map((r) => r.body), azureApi.requests.map((r) => r.body));
    assert.deepEqual(
      [github.outputs.outcome, github.outputs.cases, github.outputs['passed-cases'], github.outputs['failed-cases'], github.outputs['inconclusive-cases'], github.outputs['not-graded-cases']],
      [azure.outputs.outcome, azure.outputs.cases, azure.outputs.passedCases, azure.outputs.failedCases, azure.outputs.inconclusiveCases, azure.outputs.notGradedCases],
    );
    assert.equal(fs.readFileSync(path.join(ws, 'out', 'github.xml'), 'utf8'), fs.readFileSync(path.join(ws, 'out', 'azure.xml'), 'utf8'));
    assert.equal(github.code, azure.code);
  } finally {
    await githubApi.close();
    await azureApi.close();
  }
});

test('confidentiality: no case text or key in either log, outputs, summary or JUnit', async () => {
  const api = await startFakeApi();
  const ws = workspace(['a', 'fail-b', 'inc-c']);
  try {
    const github = await runGitHub(api, ws);
    const azure = await runAzure(api, ws);
    const everything = [
      logWithoutMaskCommands(github.stdout), github.stderr, JSON.stringify(github.outputs), github.summary,
      logWithoutMaskCommands(azure.stdout), azure.stderr, JSON.stringify(azure.outputs),
      fs.readFileSync(path.join(ws, 'out', 'github.xml'), 'utf8'), fs.readFileSync(path.join(ws, 'out', 'azure.xml'), 'utf8'),
    ].join('\n');
    assert.ok(!everything.includes(CANARY));
    assert.ok(!everything.includes(KEY));
  } finally {
    await api.close();
  }
});
