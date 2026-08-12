'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

process.env.ACTION_PATH = path.join(__dirname, '..');

const actionCore = require('../src/core');
const applyLabels = require('../src/apply-labels');
const finalize = require('../src/finalize');

const context = { repo: { owner: 'owner', repo: 'repo' } };
const labelMap = {
  bug: 'type/bug',
  question: 'type/question',
  enhancement: 'type/enhancement',
  documentation: 'type/documentation',
  duplicate: 'status/duplicate',
  'needs-info': 'status/needs-info'
};

function makeCore() {
  const outputs = {};
  const warnings = [];
  const failures = [];
  return {
    outputs,
    warnings,
    failures,
    setOutput(name, value) {
      outputs[name] = String(value);
    },
    warning(message) {
      warnings.push(String(message));
    },
    info() {},
    setFailed(message) {
      failures.push(String(message));
    }
  };
}

function makeIssue() {
  return {
    number: 1,
    state: 'open',
    title: 'Broken behavior',
    body: 'The command fails.',
    labels: [{ name: 'priority/high' }]
  };
}

function makeGithub(issue, comment, { addLabels, updateComment, getIssue } = {}) {
  const calls = { issueGets: 0, addLabels: 0, updateComment: 0 };
  return {
    calls,
    rest: {
      issues: {
        async get() {
          calls.issueGets += 1;
          if (getIssue) await getIssue(calls.issueGets);
          return { data: issue };
        },
        async getComment() {
          return { data: comment };
        },
        async updateComment(request) {
          calls.updateComment += 1;
          comment.body = request.body;
          if (updateComment) await updateComment(request);
        },
        async addLabels(request) {
          calls.addLabels += 1;
          if (addLabels) return addLabels(request);
          issue.labels.push(...request.labels.map(name => ({ name })));
          return { data: issue.labels };
        },
        async removeLabel() {
          return { data: [] };
        }
      }
    }
  };
}

async function withEnv(values, callback) {
  const previous = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value == null) delete process.env[name];
    else process.env[name] = String(value);
  }

  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function applyEnv(issue, comment, runMarker = '<!-- run:new -->') {
  return {
    ISSUE_NUMBER: '1',
    COMMENT_ID: '10',
    RUN_MARKER: runMarker,
    PREVIOUS_MANAGED_LABELS: '[]',
    ISSUE_FINGERPRINT: actionCore.issueFingerprint(issue),
    MANAGED_LABEL_FINGERPRINT: actionCore.managedLabelFingerprint(issue.labels, labelMap),
    LABEL_MAP_JSON: JSON.stringify(labelMap),
    LABEL_MANAGEMENT: 'replace',
    IGNORE_LABEL: 'ai-ignore',
    TRIAGE_RESULT: JSON.stringify({ labels: ['type/bug'] }),
    ACTION_PATH: path.join(__dirname, '..')
  };
}

function finalizeEnv(runMarker, labelSyncStatus = '') {
  return {
    ACTION_PATH: path.join(__dirname, '..'),
    COMMENT_ID: '10',
    ISSUE_NUMBER: '1',
    RUN_MARKER: runMarker,
    COMMENT_MARKER: '<!-- issue-ai-analyze -->',
    LABEL_SYNC_STATUS: labelSyncStatus,
    NORMALIZE_OK: 'false',
    NORMALIZE_ERROR: 'analysis-cancelled',
    FRESHNESS_OK: '',
    LANGUAGE_PROFILE_JSON: '{}',
    RERUN_LABELS_JSON: '[]',
    PREVIOUS_MANAGED_LABELS: '[]',
    MANAGED_LABELS: '',
    JOB_STATUS: 'cancelled',
    INFERENCE_CUSTOM_OUTCOME: 'cancelled',
    INFERENCE_COPILOT_OUTCOME: '',
    INFERENCE_ERROR: '',
    RECENT_COMMENTS_LIMIT: '10'
  };
}

test('apply labels persists ownership before a possibly cancellable API call', async () => {
  const issue = makeIssue();
  const runMarker = '<!-- run:new -->';
  const comment = { body: `pending\n${runMarker}\n<!-- issue-ai-analyze -->` };
  const github = makeGithub(issue, comment);
  const core = makeCore();

  await withEnv(applyEnv(issue, comment, runMarker), () => applyLabels({ github, context, core }));

  assert.equal(core.outputs.status, 'applied');
  assert.deepEqual(JSON.parse(core.outputs.managed_labels), ['type/bug']);
  assert.equal(github.calls.addLabels, 1);
  assert.deepEqual(actionCore.parseLabelPlan(comment.body).add, ['type/bug']);
  assert.equal(actionCore.parseLabelPlan(comment.body).confirmed, true);
});

test('apply labels does not mutate labels after a newer run takes comment ownership', async () => {
  const issue = makeIssue();
  const comment = { body: 'pending\n<!-- run:newer -->\n<!-- issue-ai-analyze -->' };
  const github = makeGithub(issue, comment);
  const core = makeCore();

  await withEnv(applyEnv(issue, comment), () => applyLabels({ github, context, core }));

  assert.equal(core.outputs.status, 'not-applied');
  assert.equal(github.calls.addLabels, 0);
  assert.deepEqual(issue.labels.map(label => label.name), ['priority/high']);
});

test('apply labels rechecks managed ownership before mutating after a comment update', async () => {
  const issue = makeIssue();
  const runMarker = '<!-- run:new -->';
  const comment = { body: `pending\n${runMarker}\n<!-- issue-ai-analyze -->` };
  const github = makeGithub(issue, comment, {
    getIssue(issueRead) {
      if (issueRead === 2) issue.labels.push({ name: 'type/question' });
    }
  });
  const core = makeCore();

  await withEnv(applyEnv(issue, comment, runMarker), () => applyLabels({ github, context, core }));

  assert.equal(core.outputs.status, 'conflict');
  assert.equal(github.calls.addLabels, 0);
  assert.deepEqual(actionCore.parseLabelPlan(comment.body).add, ['type/bug']);
});

test('apply labels recovers ownership when label mutation reports an error after changing GitHub state', async () => {
  const issue = makeIssue();
  const runMarker = '<!-- run:new -->';
  const comment = { body: `pending\n${runMarker}\n<!-- issue-ai-analyze -->` };
  const github = makeGithub(issue, comment, {
    addLabels(request) {
      issue.labels.push(...request.labels.map(name => ({ name })));
      throw new Error('response lost after mutation');
    }
  });
  const core = makeCore();

  await withEnv(applyEnv(issue, comment, runMarker), () => applyLabels({ github, context, core }));

  assert.equal(core.outputs.status, 'failed');
  assert.deepEqual(JSON.parse(core.outputs.managed_labels), []);
  assert.deepEqual(actionCore.parseLabelPlan(comment.body).add, ['type/bug']);
  assert.equal(actionCore.parseLabelPlan(comment.body).confirmed, false);
});

test('finalization keeps a pending plan when label synchronization was cancelled or skipped', async () => {
  const issue = makeIssue();
  issue.labels.push({ name: 'type/bug' });
  const runMarker = '<!-- run:new -->';
  const comment = {
    body: actionCore.upsertLabelPlanMarker(
      `pending\n${runMarker}\n<!-- issue-ai-analyze -->`,
      { add: ['type/bug'], baseLabels: [{ name: 'priority/high' }], confirmed: true }
    )
  };
  const github = makeGithub(issue, comment);
  const core = makeCore();

  await withEnv(finalizeEnv(runMarker), () => finalize({ github, context, core }));

  assert.equal(core.outputs.comment_status, 'fallback');
  assert.deepEqual(actionCore.parseLabelPlan(comment.body).add, ['type/bug']);
  assert.deepEqual(actionCore.parseManagedLabels(comment.body), ['type/bug']);
});

test('finalization publishes the upstream compatibility error in the fallback comment', async () => {
  const issue = makeIssue();
  const runMarker = '<!-- run:new -->';
  const comment = { body: `pending\n${runMarker}\n<!-- issue-ai-analyze -->` };
  const github = makeGithub(issue, comment);
  const core = makeCore();

  await withEnv({
    ...finalizeEnv(runMarker),
    JOB_STATUS: 'success',
    INFERENCE_CUSTOM_OUTCOME: 'failure',
    INFERENCE_ERROR: 'openai-compatible-http-400: This response_format type is unavailable now'
  }, () => finalize({ github, context, core }));

  assert.equal(core.outputs.comment_status, 'fallback');
  assert.match(comment.body, /openai-compatible-http-400/);
  assert.doesNotMatch(comment.body, /missing-ai-response-file/);
});

test('finalization keeps an incomplete plan even when label sync reports applied', async () => {
  const issue = makeIssue();
  const runMarker = '<!-- run:new -->';
  const comment = {
    body: actionCore.upsertLabelPlanMarker(
      `pending\n${runMarker}\n<!-- issue-ai-analyze -->`,
      { add: ['type/bug'], baseLabels: [{ name: 'priority/high' }] }
    )
  };
  const github = makeGithub(issue, comment);
  const core = makeCore();

  await withEnv(finalizeEnv(runMarker, 'applied'), () => finalize({ github, context, core }));

  assert.equal(core.outputs.comment_status, 'fallback');
  assert.deepEqual(actionCore.parseLabelPlan(comment.body).add, ['type/bug']);
});

test('finalization does not claim a planned label after a manual label conflict', async () => {
  const issue = makeIssue();
  issue.labels.push({ name: 'type/bug' });
  const runMarker = '<!-- run:new -->';
  const comment = {
    body: actionCore.upsertLabelPlanMarker(
      `pending\n${runMarker}\n<!-- issue-ai-analyze -->`,
      { add: ['type/bug'], baseLabels: [{ name: 'priority/high' }] }
    )
  };
  const github = makeGithub(issue, comment);
  const core = makeCore();

  await withEnv(finalizeEnv(runMarker, 'conflict'), () => finalize({ github, context, core }));

  assert.equal(core.outputs.comment_status, 'fallback');
  assert.deepEqual(actionCore.parseLabelPlan(comment.body).add, []);
  assert.deepEqual(actionCore.parseManagedLabels(comment.body), []);
});
