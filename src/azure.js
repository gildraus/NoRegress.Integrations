'use strict';

// Azure DevOps task adapter: reads INPUT_* variables, runs the core, sets output variables, publishes the
// JUnit file to the run's Tests tab and sets the task result, all through ##vso logging commands.

const path = require('node:path');
const core = require('./core');

function input(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
}

// Escaping used by azure-pipelines-task-lib for logging command properties and messages.
function escapeProperty(value) {
  return String(value).replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/]/g, '%5D').replace(/;/g, '%3B');
}

function escapeMessage(value) {
  return String(value).replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function command(name, properties, message = '') {
  const props = Object.entries(properties).map(([key, value]) => `${key}=${escapeProperty(value)};`).join('');
  console.log(`##vso[${name} ${props}]${escapeMessage(message)}`);
}

function resolveFromSources(file) {
  return path.resolve(process.env.SYSTEM_DEFAULTWORKINGDIRECTORY || process.cwd(), file);
}

async function main() {
  const apiKey = input('apiKey');
  if (apiKey) {
    console.log(`##vso[task.setsecret]${escapeMessage(apiKey)}`);
  }
  try {
    const suite = input('suite');
    const junitFile = resolveFromSources(input('junitFile') || core.DEFAULT_JUNIT_FILE);
    const result = await core.evaluateSuite({
      suitePath: suite ? resolveFromSources(suite) : '',
      serviceUrl: input('serviceUrl'),
      apiKey,
      batchSize: input('batchSize'),
    });
    core.writeJUnit(result, junitFile);
    const outputs = {
      outcome: result.outcome,
      cases: result.counts.cases,
      passedCases: result.counts.passed,
      failedCases: result.counts.failed,
      inconclusiveCases: result.counts.inconclusive,
      notGradedCases: result.counts.notGraded,
      junitFile,
    };
    for (const [name, value] of Object.entries(outputs)) {
      command('task.setvariable', { variable: name, isOutput: 'true' }, value);
    }
    command('results.publish', { type: 'JUnit', mergeResults: 'false', runTitle: `NoRegress ${result.suiteName}`, resultFiles: junitFile });
    if (!result.complete) {
      fail(result.error);
    } else if (result.outcome === 'failed') {
      fail(`NoRegress gate failed: ${core.formatCounts(result.counts)}.`);
    } else {
      command('task.complete', { result: 'Succeeded' }, `NoRegress gate passed: ${core.formatCounts(result.counts)}.`);
    }
  } catch (error) {
    fail(error instanceof core.NoRegressError ? error.message : `Unexpected error: ${error.message}`);
  }
}

function fail(message) {
  command('task.logissue', { type: 'error' }, message);
  command('task.complete', { result: 'Failed' }, message);
  process.exitCode = 1;
}

main();
