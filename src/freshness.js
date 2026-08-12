'use strict';

module.exports = async function run({ github, context, core }) {
const path = require('path');
const actionCore = require(path.join(process.env.ACTION_PATH, 'src', 'core.js'));
const owner = context.repo.owner;
const repo = context.repo.repo;
const issueNumber = Number(process.env.ISSUE_NUMBER || 0);
const expectedFingerprint = String(process.env.ISSUE_FINGERPRINT || '');
const expectedDiscussionFingerprint = String(process.env.DISCUSSION_FINGERPRINT || '');
const recentCommentsLimit = actionCore.normalizeLimit(process.env.RECENT_COMMENTS_LIMIT, 10, 100, 'recent-comments-limit');
const commentMarker = String(process.env.COMMENT_MARKER || '<!-- issue-ai-analyze -->').trim() || '<!-- issue-ai-analyze -->';
const ignoreLabel = String(process.env.IGNORE_LABEL || '').trim().toLowerCase();

try {
  const response = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const issue = response.data;
  const labels = (issue.labels || []).map(label =>
    String(typeof label === 'string' ? label : label.name || '').trim().toLowerCase()
  );
  const issueReason = String(issue.state || '').toLowerCase() !== 'open'
    ? 'issue-not-open'
    : ignoreLabel && labels.includes(ignoreLabel)
      ? `ignore-label:${ignoreLabel}`
      : actionCore.issueFingerprint(issue) !== expectedFingerprint
        ? 'issue-changed-during-analysis'
        : '';
  let reason = issueReason;

  if (!reason) {
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
      reason = 'discussion-changed-during-analysis';
    }
  }

  core.setOutput('ok', reason ? 'false' : 'true');
  core.setOutput('reason', reason);
  if (reason) core.warning(`Skip applying stale AI result: ${reason}`);
} catch (error) {
  core.setOutput('ok', 'false');
  core.setOutput('reason', 'freshness-check-failed');
  core.warning(`Could not verify issue freshness: ${error.message}`);
}
};
