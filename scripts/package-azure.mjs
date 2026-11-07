// Builds the Azure DevOps extension (.vsix): copies the shared core and the license next to the task,
// then runs tfx. Usage:
//   node scripts/package-azure.mjs [--publisher <id>] [--publish --token <PAT> [--share-with <org>]]
// The token can also come from the AZURE_DEVOPS_EXT_PAT environment variable.

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TFX = 'tfx-cli@0.24.2';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'azure-devops');
const task = join(ext, 'NoRegress');

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const publish = args.includes('--publish');
const publisher = option('--publisher');
const token = option('--token') || process.env.AZURE_DEVOPS_EXT_PAT;
const shareWith = option('--share-with');

// The task and extension versions must move together; the Marketplace rejects a repeated version.
const manifest = JSON.parse(readFileSync(join(ext, 'vss-extension.json'), 'utf8'));
const taskJson = JSON.parse(readFileSync(join(task, 'task.json'), 'utf8'));
const taskVersion = `${taskJson.version.Major}.${taskJson.version.Minor}.${taskJson.version.Patch}`;
if (manifest.version !== taskVersion) {
  console.error(`vss-extension.json version ${manifest.version} differs from task.json version ${taskVersion}.`);
  process.exit(1);
}

rmSync(join(task, 'src'), { recursive: true, force: true });
mkdirSync(join(task, 'src'));
for (const file of ['core.js', 'azure.js']) {
  cpSync(join(root, 'src', file), join(task, 'src', file));
}
cpSync(join(root, 'LICENSE'), join(ext, 'LICENSE'));
mkdirSync(join(root, 'dist'), { recursive: true });

// npm's own script, run with this Node, so no shell is involved and arguments are passed as they are.
function npmCli() {
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    console.error('Cannot find npm next to this Node installation.');
    process.exit(1);
  }
  return found;
}

const tfx = (...tfxArgs) => {
  // Never print the token: only the command name is logged.
  console.log(`tfx ${tfxArgs[0]} ${tfxArgs[1]}`);
  execFileSync(process.execPath, [npmCli(), 'exec', '--yes', `--package=${TFX}`, '--', 'tfx', ...tfxArgs], { cwd: ext, stdio: 'inherit' });
};

const common = ['--manifest-globs', 'vss-extension.json', '--no-prompt'];
if (publisher) {
  common.push('--publisher', publisher);
}

if (!publish) {
  tfx('extension', 'create', ...common, '--output-path', join(root, 'dist'));
} else {
  if (!token) {
    console.error('Publishing needs a token: --token <PAT> or AZURE_DEVOPS_EXT_PAT.');
    process.exit(1);
  }
  const shareArgs = shareWith ? ['--share-with', shareWith] : [];
  tfx('extension', 'publish', ...common, '--output-path', join(root, 'dist'), '--token', token, ...shareArgs);
}
