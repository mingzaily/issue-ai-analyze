'use strict';

module.exports = async function run({ github, context, core }) {
const path = require('path');
const actionCore = require(path.join(process.env.ACTION_PATH, 'src', 'core.js'));
const owner = context.repo.owner;
const repo = context.repo.repo;
const commentId = Number(process.env.COMMENT_ID || 0);
const issueNumber = Number(process.env.ISSUE_NUMBER || 0);
const commentMarker = String(process.env.COMMENT_MARKER || '<!-- issue-ai-analyze -->').trim() || '<!-- issue-ai-analyze -->';
const runMarker = String(process.env.RUN_MARKER || '').trim();
const language = JSON.parse(process.env.LANGUAGE_PROFILE_JSON || '{}');
const rerunLabels = JSON.parse(process.env.RERUN_LABELS_JSON || '[]');
const parseManagedLabelsOutput = (raw, fallback = []) => {
  if (!String(raw || '').trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};
const previousManagedLabels = parseManagedLabelsOutput(process.env.PREVIOUS_MANAGED_LABELS);
let managedLabels = parseManagedLabelsOutput(
  process.env.MANAGED_LABELS,
  previousManagedLabels
);
let pendingLabelPlan = { add: [], baseLabels: [] };
let labelPlanForOutput = pendingLabelPlan;
const expectedDiscussionFingerprint = String(process.env.DISCUSSION_FINGERPRINT || '');
const recentCommentsLimit = actionCore.normalizeLimit(process.env.RECENT_COMMENTS_LIMIT, 10, 100, 'recent-comments-limit');
const state = actionCore.decideFinalComment({
  normalizeOk: String(process.env.NORMALIZE_OK || ''),
  freshnessOk: String(process.env.FRESHNESS_OK || ''),
  freshnessReason: process.env.FRESHNESS_REASON,
  normalizeError: process.env.NORMALIZE_ERROR,
  jobStatus: process.env.JOB_STATUS,
  inferenceOutcome: process.env.INFERENCE_CUSTOM_OUTCOME || process.env.INFERENCE_GITHUB_OUTCOME,
  labelSyncStatus: process.env.LABEL_SYNC_STATUS
});
const labelSyncStatus = String(process.env.LABEL_SYNC_STATUS || '').trim().toLowerCase();
const cancellationObserved = String(process.env.JOB_STATUS || '').toLowerCase() === 'cancelled' ||
  String(process.env.INFERENCE_CUSTOM_OUTCOME || process.env.INFERENCE_GITHUB_OUTCOME || '').toLowerCase() === 'cancelled';

if (!commentId) {
  core.warning('No pending comment exists to finalize.');
  core.setOutput('comment_status', 'comment-missing');
  core.setFailed('The analysis started but no pending comment ID was available for finalization.');
  return;
}

let currentComment;
try {
  currentComment = await github.rest.issues.getComment({
    owner,
    repo,
    comment_id: commentId
  });
} catch (error) {
  core.warning(`Could not read the pending comment: ${error.message}`);
  core.setOutput('comment_status', 'publish-failed');
  core.setFailed(`Could not read the pending comment: ${error.message}`);
  return;
}

if (runMarker && !String(currentComment.data.body || '').includes(runMarker)) {
  core.info('Skip finalization because a newer analysis owns the comment.');
  core.setOutput('comment_status', 'newer-run');
  return;
}

pendingLabelPlan = actionCore.parseLabelPlan(currentComment.data.body);
labelPlanForOutput = pendingLabelPlan;
const canRecoverPendingPlan = pendingLabelPlan.confirmed && labelSyncStatus !== 'conflict' &&
  (['applied', 'failed'].includes(labelSyncStatus) || cancellationObserved);
if (labelSyncStatus === 'conflict') {
  // A conflict means a maintainer changed a managed label. Do not turn a
  // planned-but-not-confirmed addition into AI ownership in that case.
  labelPlanForOutput = { add: [], baseLabels: [] };
}

let finalState = state;
let latestIssue;
let latestIssueError;
try {
  latestIssue = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const currentLabelNames = new Set(
    (latestIssue.data.labels || [])
      .map(actionCore.labelName)
      .map(name => name.toLowerCase())
      .filter(Boolean)
  );
  const pendingPlanComplete = pendingLabelPlan.add.every(name =>
    currentLabelNames.has(String(name).trim().toLowerCase())
  );
  const recovered = canRecoverPendingPlan
    ? actionCore.recoverLabelPlanOwnership(pendingLabelPlan, latestIssue.data.labels)
    : [];
  managedLabels = actionCore.retainPresentLabels(
    [...managedLabels, ...recovered],
    latestIssue.data.labels
  );
  // An empty or non-applied status can mean the label step was cancelled or
  // skipped; keep the intent marker so a later run can reconcile it.
  if (labelSyncStatus === 'applied' && pendingLabelPlan.confirmed && pendingPlanComplete) {
    labelPlanForOutput = { add: [], baseLabels: [] };
  }
} catch (error) {
  latestIssueError = error;
  if (state.kind === 'analysis') {
    finalState = { kind: 'stale', reason: 'freshness-check-failed' };
    core.warning(`Could not verify issue before comment publication: ${error.message}`);
  } else {
    core.warning(`Could not refresh issue labels before finalization: ${error.message}`);
  }
}

if (state.kind === 'analysis' && latestIssue && !latestIssueError) {
  try {
    const issue = latestIssue.data;
    const labels = (issue.labels || []).map(label =>
      String(typeof label === 'string' ? label : label.name || '').trim().toLowerCase()
    );
    const ignoreLabel = String(process.env.IGNORE_LABEL || '').trim().toLowerCase();
    if (String(issue.state || '').toLowerCase() !== 'open') {
      finalState = { kind: 'stale', reason: 'issue-not-open' };
    } else if (ignoreLabel && labels.includes(ignoreLabel)) {
      finalState = { kind: 'stale', reason: `ignore-label:${ignoreLabel}` };
    } else if (actionCore.issueFingerprint(issue) !== String(process.env.ISSUE_FINGERPRINT || '')) {
      finalState = { kind: 'stale', reason: 'issue-changed-during-analysis' };
    } else {
      const firstCommentsResp = await github.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: Math.min(100, recentCommentsLimit + 10),
        page: 1
      });
      const lastCommentsPage = actionCore.lastPageNumber(firstCommentsResp.headers?.link);
      const latestCommentsResp = lastCommentsPage > 1
        ? await github.rest.issues.listComments({
            owner,
            repo,
            issue_number: issueNumber,
            per_page: Math.min(100, recentCommentsLimit + 10),
            page: lastCommentsPage
          })
        : firstCommentsResp;
      const latestComments = await actionCore.collectRecentComments({
        firstPage: firstCommentsResp,
        lastPage: lastCommentsPage,
        limit: recentCommentsLimit,
        cachedPages: new Map([[lastCommentsPage, latestCommentsResp]]),
        includeComment: comment => !actionCore.isBotAnalysisComment(comment, commentMarker),
        fetchPage: page => github.rest.issues.listComments({
          owner,
          repo,
          issue_number: issueNumber,
          per_page: Math.min(100, recentCommentsLimit + 10),
          page
        })
      });
      if (actionCore.discussionFingerprint(
        latestComments,
        commentMarker,
        recentCommentsLimit
      ) !== expectedDiscussionFingerprint) {
        finalState = { kind: 'stale', reason: 'discussion-changed-during-analysis' };
      }
    }
  } catch (error) {
    finalState = { kind: 'stale', reason: 'freshness-check-failed' };
    core.warning(`Could not verify issue before comment publication: ${error.message}`);
  }
}

let body;
if (finalState.kind === 'analysis') {
  const result = JSON.parse(process.env.TRIAGE_RESULT || '{}');
  body = actionCore.renderAnalysisComment({
    result,
    issueTitle: latestIssue?.data?.title || '',
    language,
    rerunLabels,
    commentMarker,
    runMarker,
    labelManagement: String(process.env.LABEL_MANAGEMENT || 'replace').trim().toLowerCase(),
    labelSyncStatus: finalState.labelSyncStatus,
    managedLabels,
    labelPlan: labelPlanForOutput
  });
} else if (finalState.kind === 'stale') {
  body = actionCore.renderStaleComment({
    language,
    commentMarker,
    runMarker,
    reason: finalState.reason,
    managedLabels,
    labelPlan: labelPlanForOutput
  });
} else {
  body = actionCore.renderFallbackComment({
    reason: finalState.reason,
    language,
    rerunLabels,
    commentMarker,
    runMarker,
    managedLabels,
    labelPlan: labelPlanForOutput
  });
}

try {
  await github.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body
  });
  core.setOutput('comment_status', finalState.kind);
  if (String(process.env.LABEL_SYNC_STATUS || '') === 'failed') {
    core.setFailed('Label synchronization failed; review the AI comment and workflow log.');
  }
} catch (error) {
  core.warning(`Could not finalize the AI comment: ${error.message}`);
  core.setOutput('comment_status', 'publish-failed');
  core.setFailed(`Could not finalize the AI comment: ${error.message}`);
}
};
