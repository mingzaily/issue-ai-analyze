'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const action = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
const runtime = [
  'src/core.js',
  'src/prepare.js',
  'src/apply-labels.js',
  'src/finalize.js'
].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
const resolver = fs.readFileSync(path.join(__dirname, '..', 'src', 'resolve.rb'), 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'issue.yml'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const readmeZh = fs.readFileSync(path.join(__dirname, '..', 'README.zh.md'), 'utf8');

test('action keeps label synchronization and comment finalization separate', () => {
  assert.match(action, /id: apply_labels[\s\S]*continue-on-error: true[\s\S]*uses: actions\/github-script@/);
  assert.match(action, /id: finalize[\s\S]*if: \$\{\{ always\(\) && steps\.prepare\.outputs\.should_run == 'true' \}\}/);
  assert.match(runtime, /managed_label_fingerprint/);
  assert.match(runtime, /discussion_fingerprint/);
  assert.match(runtime, /collectRecentComments/);
  assert.match(runtime, /retainPresentLabels/);
  assert.match(runtime, /const setStatus = \(ok, status, error = '', currentLabels = null\)/);
  assert.match(runtime, /setStatus\(false, 'conflict', '', issue\.labels\)/);
  assert.match(runtime, /let managedLabels = parseManagedLabelsOutput/);
  assert.match(runtime, /recoverLabelPlanOwnership/);
  assert.match(runtime, /Could not refresh issue labels before finalization/);
  assert.match(resolver, /overlapping_rerun_labels/);
  assert.match(resolver, /Rerun labels must not overlap mapped AI-managed labels/);
  assert.match(resolver, /overlapping_ignore_rerun_labels/);
  assert.match(resolver, /ignore-label must not overlap mapped AI-managed labels/);
  assert.match(action, /comment-missing/);
  assert.match(action, /issue_title_file/);
  assert.match(action, /current_labels_file/);
  assert.match(action, /issue_title: \$\{\{ steps\.prepare\.outputs\.issue_title_file \}\}/);
  assert.match(action, /current_labels: \$\{\{ steps\.prepare\.outputs\.current_labels_file \}\}/);
  assert.match(runtime, /maxOpenIssuePages = 20/);
  assert.match(runtime, /renderManagedLabelsMarker/);
  assert.match(runtime, /Label synchronization failed; review the AI comment and workflow log/);
  assert.match(runtime, /maxCommentSearchPages = 20/);
  assert.match(runtime, /Could not persist label ownership intent before synchronization/);
  assert.match(action, /apply-labels\.js/);
  assert.match(action, /COMMENT_ID: \$\{\{ steps\.prepare\.outputs\.comment_id \}\}/);
  assert.match(action, /RUN_MARKER: \$\{\{ steps\.prepare\.outputs\.run_marker \}\}/);
  assert.doesNotMatch(action, /name: Publish skipped analysis status/);
  assert.doesNotMatch(action, /name: Publish analysis comment/);
  assert.doesNotMatch(action, /name: Publish fallback comment/);
});

test('documentation describes rerun label isolation and every final comment state', () => {
  for (const document of [readme, readmeZh]) {
    assert.match(document, /comment-missing/);
    assert.match(document, /rerun.*(?:different|不能与)/s);
    assert.match(document, /workflow_dispatch/);
    assert.match(document, /github\.event\.issue\.number \|\| inputs\.issue-number \|\| github\.run_id/);
  }
});

test('resolver rejects rerun labels that overlap mapped AI-managed labels', () => {
  const resolver = childProcess.execFileSync(
    'ruby',
    ['-ryaml', '-e', 'puts YAML.load_file(ARGV.fetch(0)).fetch("runs").fetch("steps").first.fetch("run")', path.join(__dirname, '..', 'action.yml')],
    { encoding: 'utf8' }
  );

  const runResolver = labelMap => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-ai-analyze-resolver-'));
    const env = {
      ...process.env,
      ACTION_PATH: path.join(__dirname, '..'),
      GITHUB_ACTION: 'test-resolver',
      GITHUB_OUTPUT: path.join(tempDir, 'github-output'),
      GITHUB_RUN_ID: 'test-run',
      INPUT_LABEL_MAP: labelMap,
      INPUT_LABEL_MAP_FILE: '',
      INPUT_IGNORE_LABEL: 'ai-ignore',
      INPUT_LANGUAGE: 'en',
      INPUT_MODEL: '',
      INPUT_OPENAI_COMPAT_ENDPOINT: '',
      INPUT_OPENAI_COMPAT_TOKEN: '',
      RESOLVED_PROMPT_FILE: path.join(tempDir, 'resolved.prompt.yml'),
      RUNNER_TEMP: tempDir
    };

    try {
      return childProcess.execFileSync('bash', ['-e', '-c', resolver], {
        cwd: path.join(__dirname, '..'),
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };

  assert.doesNotThrow(() => runResolver('bug=type/bug\nrerun=ai-rerun'));
  assert.throws(
    () => runResolver('bug=type/bug\nrerun=type/bug'),
    error => error.status !== 0 && String(error.stderr).includes('Rerun labels must not overlap')
  );
  assert.throws(
    () => runResolver('bug=type/bug\nrerun=ai-ignore'),
    error => error.status !== 0 && String(error.stderr).includes('Rerun labels must not overlap ignore-label')
  );
  assert.throws(
    () => runResolver('bug=ai-ignore\nrerun=ai-rerun'),
    error => error.status !== 0 && String(error.stderr).includes('ignore-label must not overlap mapped AI-managed labels')
  );
});

test('runtime action dependencies remain pinned to immutable commits', () => {
  assert.doesNotMatch(action, /actions\/(?:github-script|ai-inference)@(?:master|main|v\d)/);
  assert.doesNotMatch(action, /@master/);
});

test('example workflow exposes a manual issue selection and per-issue cancellation', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /issue-number:/);
  assert.match(workflow, /- edited/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /issue-number: \$\{\{ inputs\.issue-number \}\}/);
});
