'use strict';

// GitHub Action adapter: reads INPUT_* variables, runs the core, writes outputs and the job summary.

const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');

function input(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
}

// GitHub workflow commands need %, CR and LF escaped in their message.
function escapeCommand(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function resolveFromWorkspace(file) {
  return path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), file);
}

function appendFile(variable, text) {
  const file = process.env[variable];
  if (file) {
    fs.appendFileSync(file, text, 'utf8');
  }
}

function setOutputs(values) {
  appendFile('GITHUB_OUTPUT', Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''));
}

function markdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/`/g, "'").replace(/[\r\n]+/g, ' ');
}

const STATUS_ICONS = { passed: '✅ passed', failed: '❌ failed', inconclusive: '⚠️ inconclusive', notGraded: '⏭️ not graded' };

function jobSummary(result) {
  const lines = [
    `## NoRegress: ${result.outcome === 'passed' ? '✅ passed' : '❌ failed'}`,
    '',
    result.complete
      ? `Suite \`${markdownCell(result.suiteName)}\`: ${core.formatCounts(result.counts)}.`
      : `Suite \`${markdownCell(result.suiteName)}\`: the evaluation is incomplete. ${markdownCell(result.error)}`,
    '',
  ];
  if (result.cases.length > 0) {
    lines.push('| Case | Result | Score | Threshold | Rules |', '| --- | --- | --- | --- | --- |');
    for (const c of result.cases) {
      const rules = [...c.failedRules.map((id) => `failed: ${id}`), ...c.errorRules.map((id) => `error: ${id}`)];
      const number = (value) => (value === null ? '' : value.toFixed(2));
      lines.push(`| \`${markdownCell(c.id)}\` | ${STATUS_ICONS[c.status]} | ${number(c.score)} | ${number(c.passThreshold)} | ${markdownCell(rules.join(', '))} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const apiKey = input('api-key');
  if (apiKey) {
    console.log(`::add-mask::${apiKey}`);
  }
  try {
    const suite = input('suite');
    const junitFile = resolveFromWorkspace(input('junit-file') || core.DEFAULT_JUNIT_FILE);
    const result = await core.evaluateSuite({
      suitePath: suite ? resolveFromWorkspace(suite) : '',
      serviceUrl: input('service-url'),
      apiKey,
      batchSize: input('batch-size'),
    });
    core.writeJUnit(result, junitFile);
    setOutputs({
      outcome: result.outcome,
      cases: result.counts.cases,
      'passed-cases': result.counts.passed,
      'failed-cases': result.counts.failed,
      'inconclusive-cases': result.counts.inconclusive,
      'not-graded-cases': result.counts.notGraded,
      'junit-file': junitFile,
    });
    appendFile('GITHUB_STEP_SUMMARY', jobSummary(result));
    if (!result.complete) {
      fail(result.error);
    } else if (result.outcome === 'failed') {
      fail(`NoRegress gate failed: ${core.formatCounts(result.counts)}.`);
    }
  } catch (error) {
    fail(error instanceof core.NoRegressError ? error.message : `Unexpected error: ${error.message}`);
  }
}

function fail(message) {
  console.log(`::error::${escapeCommand(message)}`);
  process.exitCode = 1;
}

main();
