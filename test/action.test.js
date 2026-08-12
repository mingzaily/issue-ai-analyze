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
const exampleWorkflow = fs.readFileSync(path.join(__dirname, '..', 'examples', 'issue-analyze.yml'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const readmeZh = fs.readFileSync(path.join(__dirname, '..', 'README.zh.md'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

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
  assert.match(action, /Set up Node\.js for GitHub Copilot CLI/);
  assert.match(action, /npm install --global --no-audit --no-fund @github\/copilot@latest/);
  assert.match(action, /actions\/ai-inference@2c43c91ae16266ca159d311430343c67a5ffa222/);
  assert.match(action, /src\/openai_compatible\.rb/);
  assert.match(action, /OPENAI_COMPAT_HEADERS_JSON/);
  assert.match(action, /openai-compatible-response-format/);
  assert.match(action, /INFERENCE_ERROR/);
  assert.doesNotMatch(action, /actions\/ai-inference@b81b2afb8390ee6839b494a404766bef6493c7d9/);
  assert.match(action, /GITHUB_TOKEN: \$\{\{ inputs\.github-token \}\}/);
  assert.match(action, /TRANSPORT: \$\{\{ steps\.resolve\.outputs\.transport \}\}/);
  assert.match(action, /steps\.install_copilot\.outcome == 'success'/);
  assert.doesNotMatch(action, /inference_github_models/);
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
    assert.match(document, /copilot-requests: write/);
    assert.match(document, /openai-compatible/);
    assert.match(document, /GitHub Models.*retired|GitHub Models.*退役/s);
    assert.match(document, /Allow use of Copilot CLI billed to the organization/);
    assert.match(document, /Copilot Requests/);
    assert.match(document, /does not require GitHub Copilot|不需要 GitHub Copilot/);
  }
  for (const workflowDocument of [workflow, exampleWorkflow]) {
    assert.doesNotMatch(workflowDocument, /models: read/);
    assert.match(workflowDocument, /copilot-requests: write/);
    assert.doesNotMatch(workflowDocument, /^\s+model: gpt-4\.1$/m);
  }
  assert.equal(packageJson.version, '1.2.1');
});

test('resolver rejects rerun labels that overlap mapped AI-managed labels', () => {
  const resolver = childProcess.execFileSync(
    'ruby',
    ['-ryaml', '-e', 'puts YAML.load_file(ARGV.fetch(0)).fetch("runs").fetch("steps").first.fetch("run")', path.join(__dirname, '..', 'action.yml')],
    { encoding: 'utf8' }
  );

  const runResolver = (labelMap, overrides = {}) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-ai-analyze-resolver-'));
    const outputFile = path.join(tempDir, 'github-output');
    const promptFile = path.join(tempDir, 'issue-ai-analyze-prompt-test-run-test-resolver.prompt.yml');
    const env = {
      ...process.env,
      ACTION_PATH: path.join(__dirname, '..'),
      GITHUB_ACTION: 'test-resolver',
      GITHUB_OUTPUT: outputFile,
      GITHUB_RUN_ID: 'test-run',
      INPUT_LABEL_MAP: labelMap,
      INPUT_LABEL_MAP_FILE: '',
      INPUT_IGNORE_LABEL: 'ai-ignore',
      INPUT_LANGUAGE: 'en',
      INPUT_MODEL: '',
      INPUT_OPENAI_COMPAT_ENDPOINT: '',
      INPUT_OPENAI_COMPAT_TOKEN: '',
      INPUT_OPENAI_COMPAT_HEADERS: '',
      INPUT_OPENAI_COMPAT_RESPONSE_FORMAT: '',
      RESOLVED_PROMPT_FILE: promptFile,
      RUNNER_TEMP: tempDir,
      ...overrides
    };

    try {
      const stdout = childProcess.execFileSync('bash', ['-e', '-c', resolver], {
        cwd: path.join(__dirname, '..'),
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return {
        stdout,
        output: fs.readFileSync(outputFile, 'utf8'),
        prompt: fs.readFileSync(promptFile, 'utf8')
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };

  const copilotResult = runResolver('bug=type/bug\nrerun=ai-rerun', {
    INPUT_MODEL: 'openai/gpt-4.1'
  });
  assert.match(copilotResult.output, /transport=copilot/);
  assert.match(copilotResult.output, /use_custom_endpoint=false/);
  assert.match(copilotResult.output, /resolved_model=gpt-4\.1/);
  assert.match(copilotResult.prompt, /model: gpt-4\.1/);
  assert.doesNotMatch(copilotResult.prompt, /openai\/gpt-4\.1/);

  const customResult = runResolver('bug=type/bug\nrerun=ai-rerun', {
    INPUT_MODEL: 'deepseek-chat',
    INPUT_OPENAI_COMPAT_ENDPOINT: 'https://example.test/v1',
    INPUT_OPENAI_COMPAT_TOKEN: 'test-token'
  });
  assert.match(customResult.output, /transport=openai-compatible/);
  assert.match(customResult.output, /use_custom_endpoint=true/);
  assert.match(customResult.output, /resolved_model=deepseek-chat/);
  assert.match(customResult.prompt, /model: deepseek-chat/);
  assert.match(customResult.output, /openai_compatible_response_format=auto/);
  assert.match(customResult.output, /openai_compatible_headers_json=\{\}/);

  const customLegacyModelResult = runResolver('bug=type/bug\nrerun=ai-rerun', {
    INPUT_MODEL: 'openai/gpt-4.1',
    INPUT_OPENAI_COMPAT_ENDPOINT: 'https://example.test/v1',
    INPUT_OPENAI_COMPAT_TOKEN: 'test-token'
  });
  assert.match(customLegacyModelResult.output, /resolved_model=gpt-4\.1/);
  assert.match(customLegacyModelResult.prompt, /model: gpt-4\.1/);

  const customHeadersResult = runResolver('bug=type/bug\nrerun=ai-rerun', {
    INPUT_OPENAI_COMPAT_ENDPOINT: 'https://example.test/v1',
    INPUT_OPENAI_COMPAT_TOKEN: 'test-token',
    INPUT_OPENAI_COMPAT_HEADERS: 'X-Packy-Trace: test-trace\nX-Retry: 2',
    INPUT_OPENAI_COMPAT_RESPONSE_FORMAT: 'text'
  });
  assert.match(customHeadersResult.output, /openai_compatible_response_format=prompt/);
  assert.match(customHeadersResult.output, /openai_compatible_headers_json=\{"X-Packy-Trace":"test-trace","X-Retry":"2"\}/);

  const customDefaultResult = runResolver('bug=type/bug\nrerun=ai-rerun', {
    INPUT_OPENAI_COMPAT_ENDPOINT: 'https://example.test/v1',
    INPUT_OPENAI_COMPAT_TOKEN: 'test-token'
  });
  assert.match(customDefaultResult.output, /resolved_model=gpt-4\.1/);
  assert.match(customDefaultResult.prompt, /model: gpt-4\.1/);

  const copilotDefaultResult = runResolver('bug=type/bug\nrerun=ai-rerun');
  assert.match(copilotDefaultResult.output, /transport=copilot/);
  assert.match(copilotDefaultResult.output, /resolved_model=\n/);
  assert.doesNotMatch(copilotDefaultResult.prompt, /^model:/m);

  assert.throws(
    () => runResolver('bug=type/bug', { INPUT_MODEL: 'openai/azure/gpt-4.1' }),
    error => error.status !== 0 && String(error.stderr).includes('cannot be converted')
  );
  assert.throws(
    () => runResolver('bug=type/bug', { INPUT_OPENAI_COMPAT_ENDPOINT: 'https://example.test/v1' }),
    error => error.status !== 0 && String(error.stderr).includes('must be set together')
  );
  assert.throws(
    () => runResolver('bug=type/bug', { INPUT_OPENAI_COMPAT_ENDPOINT: 'https://example.test/v1', INPUT_OPENAI_COMPAT_TOKEN: 'test-token', INPUT_OPENAI_COMPAT_HEADERS: '{"X-Test":[]}' }),
    error => error.status !== 0 && String(error.stderr).includes('must be a scalar')
  );
  assert.throws(
    () => runResolver('bug=type/bug', { INPUT_OPENAI_COMPAT_ENDPOINT: 'https://example.test/v1', INPUT_OPENAI_COMPAT_TOKEN: 'test-token', INPUT_OPENAI_COMPAT_RESPONSE_FORMAT: 'unsupported' }),
    error => error.status !== 0 && String(error.stderr).includes('Invalid openai-compatible-response-format')
  );

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
