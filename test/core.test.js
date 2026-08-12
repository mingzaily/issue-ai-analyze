'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../src/core');

test('normalizeLimit accepts bounded positive integers and rejects unsafe input', () => {
  assert.equal(core.normalizeLimit('3', 10, 100, 'recent-comments-limit'), 3);
  assert.equal(core.normalizeLimit('', 10, 100, 'recent-comments-limit'), 10);
  assert.throws(() => core.normalizeLimit('3.8', 10), /positive integer/);
  assert.throws(() => core.normalizeLimit('0', 10), /between 1 and/);
  assert.throws(() => core.normalizeLimit('not-a-number', 10), /positive integer/);
  assert.throws(() => core.normalizeLimit('101', 10, 100), /between 1 and 100/);
});

test('prompt values normalize newlines, empty values, and YAML indentation', () => {
  assert.equal(core.normalizePromptText('a\r\nb'), 'a\nb');
  assert.equal(core.normalizePromptText('', 'fallback'), 'fallback');
  assert.equal(core.formatPromptFileValue('first\nsecond', '    '), 'first\n    second');
});

test('opened, reopened, and edited issue events trigger replacement', () => {
  for (const action of ['opened', 'reopened', 'edited']) {
    const decision = core.decideTrigger({ eventName: 'issues', action, issue: { state: 'open' } });
    assert.equal(decision.shouldRun, true);
    assert.equal(decision.commentStrategy, 'replace_latest');
    assert.match(decision.triggerReason, /Issue/);
  }
  assert.equal(core.decideTrigger({
    eventName: 'issues',
    action: 'edited',
    issue: { state: 'closed' }
  }).shouldRun, false);
});

test('only configured rerun labels trigger a manual rerun for open issues', () => {
  const base = {
    eventName: 'issues',
    action: 'labeled',
    issue: { state: 'open' },
    rerunLabels: ['AI-Rerun']
  };
  assert.deepEqual(core.decideTrigger({ ...base, label: { name: 'ai-rerun' } }), {
    shouldRun: true,
    triggerReason: 'Received a configured manual rerun label. Run the AI analysis again.',
    commentStrategy: 'replace_latest',
    rerunLabelToRemove: 'ai-rerun'
  });
  assert.equal(core.decideTrigger({ ...base, label: { name: 'bug' } }).shouldRun, false);
  assert.equal(core.decideTrigger({ ...base, issue: { state: 'closed' }, label: 'ai-rerun' }).shouldRun, false);
});

test('author reply reruns only an open needs-info issue and preserves history', () => {
  const base = {
    eventName: 'issue_comment',
    issue: {
      state: 'open',
      user: { login: 'Author' },
      labels: [{ name: 'status/needs-info' }]
    },
    comment: { user: { login: 'author' } },
    mappedNeedsInfo: 'status/needs-info'
  };
  const decision = core.decideTrigger(base);
  assert.equal(decision.shouldRun, true);
  assert.equal(decision.commentStrategy, 'new_comment');
  assert.equal(core.decideTrigger({ ...base, comment: { user: { login: 'maintainer' } } }).shouldRun, false);
  assert.equal(core.decideTrigger({ ...base, issue: { ...base.issue, state: 'closed' } }).skipReason, 'issue is not open');
});

test('workflow dispatch runs a selected open issue and incomplete replies are skipped safely', () => {
  const manual = core.decideTrigger({ eventName: 'workflow_dispatch', issue: { state: 'open' } });
  assert.equal(manual.shouldRun, true);
  assert.equal(manual.commentStrategy, 'replace_latest');
  assert.match(manual.triggerReason, /workflow_dispatch/);
  assert.equal(core.decideTrigger({
    eventName: 'issue_comment',
    issue: { state: 'open', user: { login: 'author' }, labels: [] },
    comment: { user: { login: 'author' } }
  }).shouldRun, false);
  assert.equal(core.decideTrigger({
    eventName: 'issue_comment',
    issue: { state: 'open', user: { login: 'author' }, labels: ['needs-info'] },
    comment: {}
  }).shouldRun, false);
});

test('findExistingBotComment returns the latest marked bot comment', () => {
  const comments = [
    { id: 1, body: '<!-- marker -->', user: { type: 'Bot' } },
    { id: 2, body: '<!-- marker -->', user: { type: 'User' } },
    { id: 3, body: 'result <!-- marker -->', user: { type: 'Bot' } }
  ];
  assert.equal(core.findExistingBotComment(comments, '<!-- marker -->').id, 3);
  assert.equal(core.findExistingBotComment([], '<!-- marker -->'), undefined);
});

test('ignore label prevents all trigger types from running', () => {
  const decision = core.decideTrigger({
    eventName: 'issues',
    action: 'edited',
    issue: { state: 'open', labels: [{ name: 'AI-IGNORE' }] },
    ignoreLabel: 'ai-ignore'
  });
  assert.deepEqual(decision, { shouldRun: false, skipReason: 'ignore-label:ai-ignore' });
});

test('issue and comment summaries filter, limit, flatten, and truncate context', () => {
  const issues = [
    { number: 1, title: 'Current' },
    { number: 2, title: 'PR', pull_request: {}, body: 'ignored' },
    { number: 3, title: 'Candidate', labels: ['bug', { name: 'urgent' }], body: 'line 1\nline 2' },
    { number: 4, title: 'Limited out' }
  ];
  const result = core.summarizeOpenIssues(issues, 1, 1, 'empty');
  assert.deepEqual(result.issueNumbers, [3]);
  assert.equal(result.summary, '#3 | Candidate | labels=[bug, urgent] | body=line 1 line 2');
  assert.equal(core.summarizeOpenIssues([], 1, 5, 'empty').summary, 'empty');

  const comments = [
    { user: { login: 'old' }, body: 'ignored' },
    { user: { login: 'author' }, body: 'line 1\nline 2' },
    { user: { type: 'Bot' }, body: 'old AI result <!-- marker -->' },
    { body: 'x'.repeat(320) }
  ];
  const summary = core.summarizeRecentComments(comments, 2, 'empty', '<!-- marker -->').split('\n');
  assert.equal(summary[0], 'author: line 1 line 2');
  assert.equal(summary[1].length, 'unknown: '.length + 300);
  assert.equal(core.summarizeRecentComments([], 2, 'empty'), 'empty');
});

test('discussion fingerprint ignores AI comments but changes for new or edited user discussion', () => {
  const marker = '<!-- marker -->';
  const base = [
    { id: 1, user: { login: 'author', type: 'User' }, body: 'Initial', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, user: { login: 'bot', type: 'Bot' }, body: `AI result ${marker}`, created_at: '2026-01-01T00:01:00Z' }
  ];
  const fingerprint = core.discussionFingerprint(base, marker, 10);
  assert.equal(fingerprint, core.discussionFingerprint([
    ...base,
    { id: 3, user: { login: 'bot', type: 'Bot' }, body: `new AI result ${marker}` }
  ], marker, 10));
  assert.notEqual(fingerprint, core.discussionFingerprint([
    { ...base[0], body: 'Edited' }, base[1]
  ], marker, 10));
  assert.notEqual(fingerprint, core.discussionFingerprint([
    ...base,
    { id: 4, user: { login: 'author', type: 'User' }, body: 'Follow-up' }
  ], marker, 10));
});

test('lastPageNumber parses valid GitHub pagination links safely', () => {
  assert.equal(core.lastPageNumber('<https://api.github.com/comments?page=9>; rel="last"'), 9);
  assert.equal(core.lastPageNumber(''), 1);
  assert.equal(core.lastPageNumber('<https://example.test?page=nope>; rel="last"'), 1);
});

test('collectRecentComments fills the requested tail window across page boundaries', async () => {
  const calls = [];
  const recent = await core.collectRecentComments({
    firstPage: {
      data: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
      headers: { link: '<https://api.github.com/comments?page=3>; rel="last"' }
    },
    lastPage: 3,
    limit: 10,
    cachedPages: new Map([[3, { data: [
      { id: 201, user: { type: 'Bot' } },
      { id: 202, user: { type: 'User' } }
    ] }]]),
    includeComment: comment => comment.user?.type !== 'Bot',
    fetchPage: async page => {
      calls.push(page);
      return { data: Array.from({ length: 100 }, (_, index) => ({ id: index + 101 })) };
    }
  });

  assert.deepEqual(calls, [2]);
  assert.deepEqual(recent.map(comment => comment.id), [192, 193, 194, 195, 196, 197, 198, 199, 200, 202]);
});

test('parseAiJson accepts plain JSON and fenced surrounding text', () => {
  assert.deepEqual(core.parseAiJson('{"category":"bug"}'), { category: 'bug' });
  assert.deepEqual(core.parseAiJson('```json\n{"category":"question"}\n```'), { category: 'question' });
  assert.throws(() => core.parseAiJson(''), /empty-ai-response/);
  assert.throws(() => core.parseAiJson('not json'), /invalid-json-response/);
});

test('normalization maps a complete analysis and constrains fields', () => {
  const result = core.normalizeAnalysis({
    summary: '  broken   request  ',
    category: 'BUG',
    disposition: 'none',
    needsInfo: true,
    infoAssessment: 'missing version',
    supplementSuggestions: [' version ', '', 'logs', 'sample', 'ignored'],
    titleSuggestion: 'A useful title',
    duplicateOf: 12,
    confidence: 0.9
  }, {
    openIssueNumbers: [12],
    labelMap: { bug: 'type/bug', 'needs-info': 'status/needs-info' }
  });

  assert.equal(result.summary, 'broken request');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.duplicateOf, null);
  assert.deepEqual(result.supplementSuggestions, ['version', 'logs', 'sample']);
  assert.deepEqual(result.canonicalLabels, ['bug', 'needs-info']);
  assert.deepEqual(result.labels, ['type/bug', 'status/needs-info']);
});

test('normalization validates duplicate targets and applies safe fallbacks', () => {
  const duplicate = core.normalizeAnalysis({
    summary: '',
    category: 'bug',
    disposition: 'duplicate',
    needsInfo: true,
    infoAssessment: 'not retained',
    duplicateOf: 42,
    confidence: 0.8,
    supplementSuggestions: ['not retained'],
    titleSuggestion: ''
  }, {
    openIssueNumbers: [42],
    language: {
      normalize_summary_fallback: 'summary fallback',
      normalize_info_fallback: 'info fallback',
      normalize_duplicate_info: 'known duplicate'
    }
  });
  assert.equal(duplicate.category, 'bug');
  assert.equal(duplicate.disposition, 'duplicate');
  assert.equal(duplicate.needsInfo, false);
  assert.equal(duplicate.confidence, 0.8);
  assert.equal(duplicate.infoAssessment, 'known duplicate');
  assert.deepEqual(duplicate.labels, ['duplicate']);

  const invalidTarget = core.normalizeAnalysis({
    summary: 'summary',
    category: 'question',
    disposition: 'duplicate',
    needsInfo: false,
    infoAssessment: 'info',
    supplementSuggestions: [],
    titleSuggestion: '',
    duplicateOf: 99,
    confidence: 0.5
  }, { openIssueNumbers: [42] });
  assert.equal(invalidTarget.disposition, 'none');
  assert.equal(invalidTarget.duplicateOf, null);
  assert.deepEqual(invalidTarget.labels, ['question']);
});

test('normalization fails closed for malformed model results and supports custom duplicate labels', () => {
  assert.throws(() => core.normalizeAnalysis(null), /invalid-ai-result-object/);
  assert.throws(() => core.normalizeAnalysis({ category: 'bug' }), /invalid-ai-result-shape/);
  assert.throws(() => core.normalizeAnalysis({
    summary: 'summary', category: 'bug', disposition: 'none', needsInfo: 'false',
    infoAssessment: 'info', supplementSuggestions: [], titleSuggestion: '', duplicateOf: null,
    confidence: 0.5
  }), /invalid-ai-result-shape/);

  const duplicate = core.normalizeAnalysis({
    summary: 'summary',
    category: 'bug',
    disposition: 'duplicate',
    needsInfo: false,
    infoAssessment: 'info',
    supplementSuggestions: [],
    titleSuggestion: '',
    duplicateOf: 7,
    confidence: 0.4
  }, {
    openIssueNumbers: [7],
    labelMap: { duplicate: 'status/duplicate' }
  });
  assert.equal(duplicate.confidence, 0.4);
  assert.deepEqual(duplicate.labels, ['status/duplicate']);
});

test('computeLabelChanges replaces only managed labels and preserves user labels', () => {
  const changes = core.computeLabelChanges(
    ['Type/Bug', 'priority/high', 'status/needs-info'],
    ['type/question'],
    { bug: 'type/bug', question: 'type/question', 'needs-info': 'status/needs-info' }
  );
  assert.deepEqual(changes.remove, ['Type/Bug', 'status/needs-info']);
  assert.deepEqual(changes.add, ['type/question']);
  assert.deepEqual(core.computeLabelChanges(['TYPE/QUESTION'], ['type/question']).add, []);
  assert.deepEqual(core.computeLabelChanges(
    ['type/bug', 'priority/high'],
    ['Type/Question'],
    { bug: 'type/bug', question: 'type/question' },
    'add-only'
  ), { remove: [], add: ['Type/Question'] });
  assert.deepEqual(core.computeLabelChanges(
    ['type/bug'],
    ['type/question'],
    { bug: 'type/bug', question: 'type/question' },
    'none'
  ), { remove: [], add: [] });
});

test('managed label fingerprint detects manual changes but ignores unrelated labels and ordering', () => {
  const map = { bug: 'type/bug', question: 'type/question' };
  const baseline = core.managedLabelFingerprint(
    [{ name: 'priority/high' }, { name: 'TYPE/BUG' }, { name: 'type/question' }],
    map
  );
  assert.equal(
    baseline,
    core.managedLabelFingerprint(['type/question', 'priority/low', 'type/bug'], map)
  );
  assert.notEqual(
    baseline,
    core.managedLabelFingerprint(['type/question', 'priority/high', 'type/docs'], map)
  );
});

test('managed label ownership marker round-trips safely', () => {
  const marker = core.renderManagedLabelsMarker(['type/bug', 'status/needs-info', 'type/bug']);
  assert.deepEqual(core.parseManagedLabels(marker), ['type/bug', 'status/needs-info']);
  assert.deepEqual(core.parseManagedLabels('<!-- issue-ai-analyze-managed-labels:bad! -->'), []);
  assert.deepEqual(core.parseManagedLabels(''), []);
  assert.deepEqual(
    core.retainPresentLabels(['Type/Bug', 'status/needs-info'], [{ name: 'type/bug' }, { name: 'priority/high' }]),
    ['type/bug']
  );
});

test('pending label plans recover only labels added after their baseline', () => {
  const body = core.upsertLabelPlanMarker('pending', {
    add: ['type/bug', 'status/needs-info'],
    baseLabels: ['priority/high', 'status/needs-info'],
    confirmed: true
  });

  const plan = core.parseLabelPlan(body);
  assert.deepEqual(plan, {
    add: ['type/bug', 'status/needs-info'],
    baseLabels: ['priority/high', 'status/needs-info'],
    confirmed: true
  });
  assert.deepEqual(
    core.recoverLabelPlanOwnership(plan, [
      { name: 'type/bug' },
      { name: 'status/needs-info' },
      { name: 'priority/high' }
    ]),
    ['type/bug']
  );
  assert.deepEqual(core.parseLabelPlan(core.upsertLabelPlanMarker(body, {})), {
    add: [],
    baseLabels: [],
    confirmed: false
  });
  assert.deepEqual(core.recoverLabelPlanOwnership({
    add: ['type/bug'],
    baseLabels: ['priority/high']
  }, [{ name: 'type/bug' }]), []);
});

test('replace policy removes only labels previously owned by AI', () => {
  assert.deepEqual(core.computeLabelChanges(
    ['type/bug', 'type/question', 'priority/high'],
    ['type/question'],
    { bug: 'type/bug', question: 'type/question' },
    'replace',
    ['type/question']
  ), { remove: [], add: [] });
  assert.deepEqual(core.computeLabelChanges(
    ['type/bug', 'type/question'],
    ['type/question'],
    { bug: 'type/bug', question: 'type/question' },
    'replace',
    ['type/bug', 'type/question']
  ), { remove: ['type/bug'], add: [] });
});

test('rerun labels render naturally in Chinese and English', () => {
  assert.equal(core.formatRerunLabels([], 'en'), '`ai-rerun`');
  assert.equal(core.formatRerunLabels(['one'], 'en'), '`one`');
  assert.equal(core.formatRerunLabels(['one', 'two'], 'zh'), '`one`、`two`');
  assert.equal(core.formatRerunLabels(['one', 'two'], 'en'), '`one` or `two`');
  assert.equal(core.formatRerunLabels(['one', 'two', 'three'], 'en'), '`one`, `two`, or `three`');
  assert.equal(core.renderTemplate('Add {{rerun_labels}}.', ['retry'], 'en'), 'Add `retry`.');
});

test('analysis comment renders duplicate and supplement details', () => {
  const body = core.renderAnalysisComment({
    result: {
      summary: 'A summary',
      labels: ['duplicate'],
      titleSuggestion: '',
      infoAssessment: 'Enough info',
      confidence: 0.876,
      duplicateOf: 12,
      supplementSuggestions: ['Attach logs'],
      needsInfo: false
    },
    issueTitle: 'Original title',
    language: { rerun_manual_template: 'Add {{rerun_labels}}.', code: 'en' },
    rerunLabels: ['ai-rerun'],
    commentMarker: '<!-- marker -->'
  });
  assert.match(body, /Suggested title\*\*: Original title/);
  assert.match(body, /Confidence\*\*: 88%/);
  assert.match(body, /Possible duplicate of\*\*: #12/);
  assert.match(body, /### Optional follow-up\n- Attach logs/);
  assert.match(body, /Add `ai-rerun`\./);
  assert.ok(body.endsWith('<!-- marker -->'));
});

test('analysis comment supports needs-info suggestions and empty labels', () => {
  const body = core.renderAnalysisComment({
    result: {
      summary: 'A summary', labels: [], titleSuggestion: 'Suggested', infoAssessment: 'Missing',
      confidence: 0, duplicateOf: null, supplementSuggestions: ['Version'], needsInfo: true
    },
    issueTitle: 'Original',
    commentMarker: '<!-- marker -->'
  });
  assert.match(body, /Suggested labels\*\*: \(none\)/);
  assert.match(body, /### Suggested follow-up/);
});

test('analysis comment omits optional sections when they are absent', () => {
  const body = core.renderAnalysisComment({
    result: {
      summary: 'A summary', labels: ['question'], titleSuggestion: 'Suggested', infoAssessment: 'Enough',
      confidence: 0.5, duplicateOf: null, supplementSuggestions: [], needsInfo: false
    },
    issueTitle: 'Original',
    language: { analysis_title: 'Analysis' },
    rerunLabels: [],
    commentMarker: '<!-- marker -->'
  });
  assert.ok(body.startsWith('Analysis'));
  assert.doesNotMatch(body, /Possible duplicate/);
  assert.doesNotMatch(body, /follow-up/);
  assert.match(body, /`ai-rerun`/);
});

test('fallback comment escapes diagnostics and localizes retry labels', () => {
  const body = core.renderFallbackComment({
    reason: 'bad `response`',
    language: { code: 'zh', fallback_retry_template: '添加 {{rerun_labels}} 后重试。' },
    rerunLabels: ['ai-rerun', 'ai-recheck'],
    commentMarker: '<!-- marker -->'
  });
  assert.match(body, /bad &#96;response&#96;/);
  assert.match(body, /添加 `ai-rerun`、`ai-recheck` 后重试/);
  assert.ok(body.endsWith('<!-- marker -->'));
});

test('fallback comment supplies default text for a missing diagnostic', () => {
  const body = core.renderFallbackComment({ commentMarker: '<!-- marker -->' });
  assert.match(body, /unknown-error/);
  assert.match(body, /`ai-rerun`/);
});

test('stale comment explains why a result was not applied and keeps run ownership', () => {
  const body = core.renderStaleComment({
    language: { stale_title: 'Stale', stale_body: 'Not applied', fallback_manual: 'Manual' },
    runMarker: '<!-- run:1 -->',
    commentMarker: '<!-- marker -->'
  });
  assert.match(body, /Stale\n\nNot applied/);
  assert.match(body, /<!-- run:1 -->/);
  assert.ok(body.endsWith('<!-- marker -->'));
});

test('stale comment distinguishes an API verification failure', () => {
  const body = core.renderStaleComment({
    language: {
      stale_title: 'Stale',
      stale_body_verification_failed: 'Could not verify',
      fallback_manual: 'Manual'
    },
    reason: 'freshness-check-failed',
    commentMarker: '<!-- marker -->'
  });
  assert.match(body, /Stale\n\nCould not verify/);
});

test('final comment decision covers cancellation, stale results, and label outcomes', () => {
  assert.deepEqual(core.decideFinalComment({
    normalizeOk: '',
    jobStatus: 'cancelled',
    inferenceOutcome: 'cancelled'
  }), { kind: 'fallback', reason: 'analysis-cancelled' });
  assert.deepEqual(core.decideFinalComment({
    normalizeOk: 'true',
    freshnessOk: 'false',
    freshnessReason: 'ignore-label:ai-ignore'
  }), { kind: 'stale', reason: 'ignore-label:ai-ignore' });
  assert.deepEqual(core.decideFinalComment({
    normalizeOk: 'true',
    freshnessOk: ''
  }), { kind: 'stale', reason: 'freshness-check-failed' });
  assert.deepEqual(core.decideFinalComment({
    normalizeOk: 'true',
    freshnessOk: 'true',
    labelSyncStatus: 'conflict'
  }), { kind: 'analysis', labelSyncStatus: 'conflict' });
  assert.deepEqual(core.decideFinalComment({
    normalizeOk: '',
    transport: 'copilot',
    copilotInstallOutcome: 'failure'
  }), { kind: 'fallback', reason: 'copilot-cli-install-failed' });
  assert.deepEqual(core.decideFinalComment({
    normalizeOk: '',
    transport: 'copilot',
    copilotInstallOutcome: 'success',
    inferenceOutcome: 'failure'
  }), { kind: 'fallback', reason: 'copilot-inference-failed' });
});

test('Copilot failure diagnostics render as safe fallback content', () => {
  const body = core.renderFallbackComment({
    reason: 'copilot-inference-failed',
    language: { code: 'en' },
    commentMarker: '<!-- marker -->'
  });
  assert.match(body, /Diagnostic\*\*: `copilot-inference-failed`/);
  assert.match(body, /add label `ai-rerun`/);
});

test('analysis comment reports a label synchronization conflict instead of claiming success', () => {
  const body = core.renderAnalysisComment({
    result: {
      summary: 'Summary', labels: ['bug'], titleSuggestion: '', infoAssessment: 'Enough',
      confidence: 0.5, duplicateOf: null, supplementSuggestions: [], needsInfo: false
    },
    language: {
      sync_note_conflict: 'Manual label change preserved',
      rerun_manual_template: 'Retry with {{rerun_labels}}.'
    },
    labelSyncStatus: 'conflict',
    commentMarker: '<!-- marker -->'
  });
  assert.match(body, /Manual label change preserved/);
  assert.doesNotMatch(body, /already been synced/);
});

test('safeString and labelName normalize untrusted scalar values', () => {
  assert.equal(core.safeString(' a\n b ', 4), 'a b');
  assert.equal(core.labelName(' bug '), 'bug');
  assert.equal(core.labelName({ name: ' docs ' }), 'docs');
  assert.equal(core.labelName(null), '');
});

test('comment rendering neutralizes mentions and marker injection from model text', () => {
  const body = core.renderAnalysisComment({
    result: {
      summary: 'Please notify @maintainer <!-- fake --> [link](https://example.com)',
      labels: ['question'],
      titleSuggestion: 'Title @owner',
      infoAssessment: 'Enough',
      confidence: 0.5,
      duplicateOf: null,
      supplementSuggestions: ['Ask @user'],
      needsInfo: false
    },
    issueTitle: 'Original @author',
    commentMarker: '<!-- marker -->'
  });
  assert.doesNotMatch(body, /@maintainer(?!\u200b)/);
  assert.match(body, /@\u200bmaintainer/);
  assert.match(body, /&lt;!-- fake --&gt;/);
  assert.ok(body.includes('\\[link\\]\\(https://example.com\\)'));
  assert.ok(body.endsWith('<!-- marker -->'));
});

test('issue fingerprint changes when title or body changes', () => {
  const base = { title: 'Title', body: 'Body' };
  assert.equal(core.issueFingerprint(base), core.issueFingerprint({ ...base }));
  assert.notEqual(core.issueFingerprint(base), core.issueFingerprint({ ...base, body: 'Changed' }));
  assert.notEqual(core.issueFingerprint(base), core.issueFingerprint({ ...base, title: 'Changed' }));
});
