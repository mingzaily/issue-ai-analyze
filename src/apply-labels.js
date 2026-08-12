'use strict';

module.exports = async function run({ github, context, core }) {
const path = require('path');
const actionCore = require(path.join(process.env.ACTION_PATH, 'src', 'core.js'));
const owner = context.repo.owner;
const repo = context.repo.repo;
const issueNumber = Number(process.env.ISSUE_NUMBER || 0);
const commentId = Number(process.env.COMMENT_ID || 0);
const runMarker = String(process.env.RUN_MARKER || '').trim();
const previousManagedLabels = JSON.parse(process.env.PREVIOUS_MANAGED_LABELS || '[]');
const setStatus = (ok, status, error = '', currentLabels = null) => {
  // Never carry ownership for a label that is no longer present. This
  // matters when a maintainer removes an AI-managed label while the
  // analysis is running and the run ends as stale/conflict/ignored.
  const managedLabels = currentLabels == null
    ? previousManagedLabels
    : actionCore.retainPresentLabels(previousManagedLabels, currentLabels);
  core.setOutput('ok', ok ? 'true' : 'false');
  core.setOutput('status', status);
  core.setOutput('managed_labels', JSON.stringify(managedLabels));
  if (error) core.setOutput('error', String(error).slice(0, 1000));
};

const labelManagement = String(process.env.LABEL_MANAGEMENT || 'replace').trim().toLowerCase();
if (labelManagement === 'none') {
  setStatus(true, 'policy-none');
  return;
}

try {
  const latestIssue = await github.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber
  });
  let issue = latestIssue.data;
  const expectedIssueFingerprint = String(process.env.ISSUE_FINGERPRINT || '');
  if (actionCore.issueFingerprint(issue) !== expectedIssueFingerprint) {
    setStatus(false, 'stale', '', issue.labels);
    core.warning('Issue changed between freshness checks; labels were not changed.');
    return;
  }

  const ignoreLabel = String(process.env.IGNORE_LABEL || '').trim().toLowerCase();
  const currentLabels = (issue.labels || []).map(label =>
    String(typeof label === 'string' ? label : label.name || '').trim().toLowerCase()
  );
  if (String(issue.state || '').toLowerCase() !== 'open') {
    setStatus(false, 'stale', '', issue.labels);
    core.warning('Issue is no longer open; labels were not changed.');
    return;
  }
  if (ignoreLabel && currentLabels.includes(ignoreLabel)) {
    setStatus(false, 'ignored', '', issue.labels);
    core.warning(`Issue received ${ignoreLabel}; labels were not changed.`);
    return;
  }

  const labelMap = JSON.parse(process.env.LABEL_MAP_JSON || '{}');
  const expectedManagedFingerprint = String(process.env.MANAGED_LABEL_FINGERPRINT || '');
  if (actionCore.managedLabelFingerprint(issue.labels, labelMap) !== expectedManagedFingerprint) {
    setStatus(false, 'conflict', '', issue.labels);
    core.warning('A managed label changed during analysis; manual label changes were preserved.');
    return;
  }

  const result = JSON.parse(process.env.TRIAGE_RESULT);
  let changes = actionCore.computeLabelChanges(
    issue.labels,
    result.labels,
    labelMap,
    labelManagement,
    previousManagedLabels
  );
  const errors = [];
  let labelPlan = null;

  if (changes.add.length > 0) {
    if (!commentId || !runMarker) {
      setStatus(false, 'failed', 'missing-comment-ownership-context');
      core.warning('Could not persist label ownership intent before synchronization.');
      return;
    }

    try {
      const pendingComment = await github.rest.issues.getComment({
        owner,
        repo,
        comment_id: commentId
      });
      const pendingBody = String(pendingComment.data.body || '');
      if (!pendingBody.includes(runMarker)) {
        setStatus(false, 'not-applied');
        core.info('Skip label synchronization because a newer analysis owns the pending comment.');
        return;
      }

      const previousPlan = actionCore.parseLabelPlan(pendingBody);
      labelPlan = {
        add: [...previousPlan.add, ...changes.add],
        baseLabels: [...(issue.labels || [])]
      };
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body: actionCore.upsertLabelPlanMarker(pendingBody, labelPlan)
      });
    } catch (error) {
      setStatus(false, 'failed', `ownership-plan: ${error.message}`);
      core.warning(`Could not persist label ownership intent: ${error.message}`);
      return;
    }
  }

  if (changes.remove.length > 0 || changes.add.length > 0) {
    const refreshedIssueResp = await github.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber
    });
    const refreshedIssue = refreshedIssueResp.data;
    const refreshedLabels = (refreshedIssue.labels || []).map(label =>
      String(typeof label === 'string' ? label : label.name || '').trim().toLowerCase()
    );
    if (actionCore.issueFingerprint(refreshedIssue) !== expectedIssueFingerprint) {
      setStatus(false, 'stale', '', refreshedIssue.labels);
      core.warning('Issue changed immediately before label synchronization; labels were not changed.');
      return;
    }
    if (String(refreshedIssue.state || '').toLowerCase() !== 'open') {
      setStatus(false, 'stale', '', refreshedIssue.labels);
      core.warning('Issue is no longer open immediately before label synchronization; labels were not changed.');
      return;
    }
    if (ignoreLabel && refreshedLabels.includes(ignoreLabel)) {
      setStatus(false, 'ignored', '', refreshedIssue.labels);
      core.warning(`Issue received ${ignoreLabel} immediately before label synchronization; labels were not changed.`);
      return;
    }
    if (actionCore.managedLabelFingerprint(refreshedIssue.labels, labelMap) !== expectedManagedFingerprint) {
      setStatus(false, 'conflict', '', refreshedIssue.labels);
      core.warning('A managed label changed immediately before synchronization; manual label changes were preserved.');
      return;
    }

    issue = refreshedIssue;
    changes = actionCore.computeLabelChanges(
      issue.labels,
      result.labels,
      labelMap,
      labelManagement,
      previousManagedLabels
    );
  }

  if (changes.remove.length > 0 || changes.add.length > 0) {
    if (!commentId || !runMarker) {
      setStatus(false, 'failed', 'missing-comment-ownership-context');
      core.warning('Could not verify comment ownership before label synchronization.');
      return;
    }

    const currentComment = await github.rest.issues.getComment({
      owner,
      repo,
      comment_id: commentId
    });
    if (!String(currentComment.data.body || '').includes(runMarker)) {
      setStatus(false, 'not-applied');
      core.info('Skip label synchronization because a newer analysis owns the pending comment.');
      return;
    }
  }

  const managedByLower = new Map(
    actionCore.retainPresentLabels(previousManagedLabels, issue.labels)
      .map(name => [name.toLowerCase(), name])
  );

  for (const name of changes.remove) {
    try {
      await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name
      });
      managedByLower.delete(name.toLowerCase());
    } catch (error) {
      errors.push(`remove ${name}: ${error.message}`);
    }
  }

  let addSucceeded = false;
  if (changes.add.length > 0) {
    try {
      await github.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: changes.add
      });
      addSucceeded = true;
    } catch (error) {
      errors.push(`add ${changes.add.join(', ')}: ${error.message}`);
    }
  }

  if (addSucceeded && labelPlan) {
    try {
      const confirmedComment = await github.rest.issues.getComment({
        owner,
        repo,
        comment_id: commentId
      });
      const confirmedBody = String(confirmedComment.data.body || '');
      if (!confirmedBody.includes(runMarker)) {
        errors.push('confirm ownership: a newer analysis owns the pending comment');
      } else {
        labelPlan = { ...labelPlan, confirmed: true };
        await github.rest.issues.updateComment({
          owner,
          repo,
          comment_id: commentId,
          body: actionCore.upsertLabelPlanMarker(confirmedBody, labelPlan)
        });
      }
    } catch (error) {
      errors.push(`confirm ownership: ${error.message}`);
    }
  }

  if (addSucceeded && labelPlan?.confirmed) {
    for (const name of changes.add) managedByLower.set(name.toLowerCase(), name);
  }

  let managedLabels = Array.from(managedByLower.values());
  if (errors.length > 0) {
    if (labelPlan) {
      try {
        const refreshedIssue = await github.rest.issues.get({
          owner,
          repo,
          issue_number: issueNumber
        });
        const recovered = actionCore.recoverLabelPlanOwnership(labelPlan, refreshedIssue.data.labels);
        managedLabels = actionCore.retainPresentLabels(
          [...managedLabels, ...recovered],
          refreshedIssue.data.labels
        );
      } catch (error) {
        core.warning(`Could not verify labels after a synchronization error: ${error.message}`);
      }
    }
    core.setOutput('managed_labels', JSON.stringify(managedLabels));
    core.setOutput('ok', 'false');
    core.setOutput('status', 'failed');
    core.setOutput('error', errors.join('; ').slice(0, 1000));
    core.warning(`Label synchronization was incomplete: ${errors.join('; ')}`);
    return;
  }

  core.setOutput('managed_labels', JSON.stringify(managedLabels));
  core.setOutput('ok', 'true');
  core.setOutput('status', 'applied');
} catch (error) {
  setStatus(false, 'failed', error.message || error);
  core.warning(`Could not synchronize labels: ${error.message}`);
}
};
