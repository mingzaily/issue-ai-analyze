'use strict';

module.exports = async function run({ github, context, core }) {
const fs = require('fs');
const path = require('path');
const actionCore = require(path.join(process.env.ACTION_PATH, 'src', 'core.js'));

const labelMap = JSON.parse(process.env.LABEL_MAP_JSON || '{}');
const language = JSON.parse(process.env.LANGUAGE_PROFILE_JSON || '{}');
const rerunLabels = JSON.parse(process.env.RERUN_LABELS_JSON || '[]');
const fileInputIndentMap = JSON.parse(process.env.FILE_INPUT_INDENT_JSON || '{}');
const t = (key, fallback = '') => String(language[key] || fallback);
const commentMarker = String(process.env.COMMENT_MARKER || '<!-- issue-ai-analyze -->').trim() || '<!-- issue-ai-analyze -->';
const recentCommentsLimit = actionCore.normalizeLimit(process.env.RECENT_COMMENTS_LIMIT, 10, 100, 'recent-comments-limit');
const openIssuesLimit = actionCore.normalizeLimit(process.env.OPEN_ISSUES_LIMIT, 50, 100, 'open-issues-limit');
const mappedNeedsInfo = String(labelMap['needs-info'] || 'needs-info').trim().toLowerCase();
const ignoreLabel = String(process.env.IGNORE_LABEL || '').trim().toLowerCase();
const labelManagement = String(process.env.LABEL_MANAGEMENT || 'replace').trim().toLowerCase();
if (!['replace', 'add-only', 'none'].includes(labelManagement)) {
  throw new Error('label-management must be one of: replace, add-only, none');
}

const owner = context.repo.owner;
const repo = context.repo.repo;
const payloadIssueNumber = context.payload.issue?.number;
const workflowIssueNumber = context.payload.inputs?.['issue-number'] || context.payload.inputs?.issue_number;
const configuredIssueNumber = String(process.env.INPUT_ISSUE_NUMBER || '').trim();
const issueNumberText = String(payloadIssueNumber || configuredIssueNumber || workflowIssueNumber || '').trim();

if (!issueNumberText) {
  core.setOutput('should_run', 'false');
  core.setOutput('skip_reason', 'no-issue-number');
  core.info('Skip: no issue number was provided.');
  return;
}

if (!/^\d+$/.test(issueNumberText) || !Number.isSafeInteger(Number(issueNumberText)) || Number(issueNumberText) < 1) {
  throw new Error(`Invalid issue number: ${issueNumberText}`);
}

const issueNumber = Number(issueNumberText);
core.setOutput('issue_number', String(issueNumber));

const issueResp = await github.rest.issues.get({
  owner,
  repo,
  issue_number: issueNumber
});
const issue = issueResp.data;

if (issue.pull_request) {
  core.setOutput('should_run', 'false');
  core.setOutput('skip_reason', 'pull-request-not-supported');
  core.info('Skip: pull request conversation is not supported.');
  return;
}

const trigger = actionCore.decideTrigger({
  eventName: context.eventName,
  action: context.payload.action,
  issue,
  label: context.payload.label,
  comment: context.payload.comment,
  mappedNeedsInfo,
  rerunLabels,
  ignoreLabel
});

if (!trigger.shouldRun) {
  core.setOutput('should_run', 'false');
  core.setOutput('skip_reason', trigger.skipReason);
  core.info(`Skip: ${trigger.skipReason}.`);
  return;
}

if (trigger.rerunLabelToRemove) {
  try {
    await github.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: trigger.rerunLabelToRemove
    });
  } catch (error) {
    core.info(`Skip removing rerun label ${trigger.rerunLabelToRemove}: ${error.message}`);
  }
}

const triggerReason = trigger.triggerReason;
const commentStrategy = trigger.commentStrategy;
const runMarker = `<!-- issue-ai-analyze-run:${process.env.GITHUB_RUN_ID || 'local'} -->`;

const commentFetchLimit = Math.min(100, Math.max(recentCommentsLimit * 2, recentCommentsLimit + 10));
const firstCommentsResp = await github.rest.issues.listComments({
  owner,
  repo,
  issue_number: issueNumber,
  per_page: commentFetchLimit,
  page: 1
});
const lastCommentsPage = actionCore.lastPageNumber(firstCommentsResp.headers?.link);
const latestCommentsResp = lastCommentsPage > 1
  ? await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: commentFetchLimit,
      page: lastCommentsPage
    })
  : firstCommentsResp;
const latestPageComments = latestCommentsResp.data || [];
const comments = await actionCore.collectRecentComments({
  firstPage: firstCommentsResp,
  lastPage: lastCommentsPage,
  limit: recentCommentsLimit,
  cachedPages: new Map([[lastCommentsPage, latestCommentsResp]]),
  includeComment: comment => !actionCore.isBotAnalysisComment(comment, commentMarker),
  fetchPage: page => github.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: commentFetchLimit,
    page
  })
});
let existingComment = actionCore.findExistingBotComment(latestPageComments, commentMarker);
let searchPage = lastCommentsPage - 1;
let searchedPages = 0;
const maxCommentSearchPages = 20;
while (!existingComment && searchPage >= 1 && searchedPages < maxCommentSearchPages) {
  const historicalCommentsResp = searchPage === 1
    ? firstCommentsResp
    : await github.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: commentFetchLimit,
        page: searchPage
      });
  existingComment = actionCore.findExistingBotComment(
    [...(historicalCommentsResp.data || []), ...latestPageComments],
    commentMarker
  );
  searchPage -= 1;
  searchedPages += 1;
}

if (!existingComment && searchPage >= 1) {
  core.warning(`Could not find an existing AI comment after searching ${searchedPages} historical comment pages; a new comment may be created.`);
}

const parsedLabelPlan = actionCore.parseLabelPlan(existingComment?.body);
const pendingLabelPlan = parsedLabelPlan.confirmed
  ? {
      ...parsedLabelPlan,
      add: actionCore.retainPresentLabels(parsedLabelPlan.add, issue.labels)
    }
  : parsedLabelPlan;
const previousManagedLabels = actionCore.retainPresentLabels([
  ...actionCore.parseManagedLabels(existingComment?.body),
  ...actionCore.recoverLabelPlanOwnership(pendingLabelPlan, issue.labels)
], issue.labels);

const pendingLines = [
  t('pending_title', '## 🤖 AI Analysis In Progress'),
  '',
  t('pending_body', 'Analyzing this issue and preparing a summary plus label suggestions. Please wait…'),
  '',
  commentStrategy === 'new_comment'
    ? t('pending_preserve')
    : t('pending_replace'),
  actionCore.renderManagedLabelsMarker(previousManagedLabels),
  ...(actionCore.renderLabelPlanMarker(pendingLabelPlan) ? [actionCore.renderLabelPlanMarker(pendingLabelPlan)] : []),
  runMarker,
  commentMarker
];

let commentId = 0;
if (existingComment && commentStrategy === 'replace_latest') {
  await github.rest.issues.updateComment({
    owner,
    repo,
    comment_id: existingComment.id,
    body: pendingLines.join('\n')
  });
  commentId = existingComment.id;
} else {
  const createResp = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: pendingLines.join('\n')
  });
  commentId = createResp.data.id;
}

// Set the ownership outputs immediately after creating the pending comment.
// If a later context fetch fails, the always-run finalizer can still close the loop.
core.setOutput('should_run', 'true');
core.setOutput('skip_reason', '');
core.setOutput('comment_id', String(commentId));
core.setOutput('issue_number', String(issueNumber));
core.setOutput('trigger_reason', triggerReason);
core.setOutput('comment_strategy', commentStrategy);
core.setOutput('issue_fingerprint', actionCore.issueFingerprint(issue));
core.setOutput('managed_label_fingerprint', actionCore.managedLabelFingerprint(issue.labels, labelMap));
core.setOutput('previous_managed_labels', JSON.stringify(previousManagedLabels));
core.setOutput('discussion_fingerprint', actionCore.discussionFingerprint(comments, commentMarker, recentCommentsLimit));
core.setOutput('run_marker', runMarker);

const openIssueCandidates = [];
const openIssuePageSize = 100;
const maxOpenIssuePages = 20;
let openIssuePage = 1;
let lastOpenIssuePage = 1;
const hasEnoughOpenIssues = () => openIssueCandidates.filter(issue =>
  !issue.pull_request && issue.number !== issueNumber
).length >= openIssuesLimit;

while (openIssuePage <= lastOpenIssuePage && openIssuePage <= maxOpenIssuePages && !hasEnoughOpenIssues()) {
  const openIssuesResp = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    per_page: openIssuePageSize,
    page: openIssuePage,
    sort: 'updated',
    direction: 'desc'
  });
  openIssueCandidates.push(...(openIssuesResp.data || []));
  lastOpenIssuePage = actionCore.lastPageNumber(openIssuesResp.headers?.link);
  if ((openIssuesResp.data || []).length === 0) break;
  openIssuePage += 1;
}

if (!hasEnoughOpenIssues() && openIssuePage <= lastOpenIssuePage) {
  core.warning(`Could not collect ${openIssuesLimit} open issue candidates after ${maxOpenIssuePages} pages; duplicate detection may use fewer candidates.`);
}
const openIssueContext = actionCore.summarizeOpenIssues(
  openIssueCandidates,
  issueNumber,
  openIssuesLimit,
  '（当前没有其他 open issues）'
);
const openIssueNumbers = openIssueContext.issueNumbers;
const openIssueSummary = openIssueContext.summary;
const recentComments = actionCore.summarizeRecentComments(
  comments,
  recentCommentsLimit,
  '（暂无评论）',
  commentMarker
);

const baseDir = process.env.RUNNER_TEMP || process.cwd();
const bodyFile = path.join(baseDir, `issue-${issueNumber}-body.md`);
const titleFile = path.join(baseDir, `issue-${issueNumber}-title.txt`);
const labelsFile = path.join(baseDir, `issue-${issueNumber}-labels.txt`);
const openIssuesFile = path.join(baseDir, `issue-${issueNumber}-open-issues.txt`);
const commentsFile = path.join(baseDir, `issue-${issueNumber}-comments.txt`);

const currentLabels = (issue.labels || [])
  .map(label => String(typeof label === 'string' ? label : label.name || '').trim())
  .filter(Boolean)
  .join(', ') || '（无）';

fs.writeFileSync(
  titleFile,
  actionCore.formatPromptFileValue(issue.title, String(fileInputIndentMap.issue_title || '    '), '（无标题）')
);
fs.writeFileSync(
  labelsFile,
  actionCore.formatPromptFileValue(currentLabels, String(fileInputIndentMap.current_labels || '    '))
);
fs.writeFileSync(
  bodyFile,
  actionCore.formatPromptFileValue(issue.body, String(fileInputIndentMap.issue_body || '    '), '（无正文）')
);
fs.writeFileSync(
  openIssuesFile,
  actionCore.formatPromptFileValue(openIssueSummary, String(fileInputIndentMap.open_issues || '    '))
);
fs.writeFileSync(
  commentsFile,
  actionCore.formatPromptFileValue(recentComments, String(fileInputIndentMap.recent_comments || '    '))
);

core.setOutput('issue_title_file', titleFile);
core.setOutput('current_labels_file', labelsFile);
core.setOutput('issue_body_file', bodyFile);
core.setOutput('open_issues_file', openIssuesFile);
core.setOutput('recent_comments_file', commentsFile);
core.setOutput('open_issue_numbers', JSON.stringify(openIssueNumbers));
};
