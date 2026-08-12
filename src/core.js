'use strict';

const crypto = require('crypto');

const TRIGGER_REASONS = Object.freeze({
  opened: 'Issue opened. Run the initial AI analysis.',
  reopened: 'Issue reopened. Run the initial AI analysis again.',
  edited: 'Issue title or body changed. Run the initial AI analysis again.',
  authorReply: 'The issue author replied while the issue is in needs-info state. Run the AI analysis again.',
  manualRerun: 'Received a configured manual rerun label. Run the AI analysis again.',
  manualDispatch: 'A workflow_dispatch run selected this issue. Run the AI analysis again.'
});

const MANAGED_CANONICAL_LABELS = Object.freeze([
  'bug',
  'question',
  'enhancement',
  'documentation',
  'duplicate',
  'needs-info'
]);

function labelName(label) {
  return String(typeof label === 'string' ? label : label?.name || '').trim();
}

function normalizeLimit(value, fallback, max = 100, name = 'limit') {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }

  return parsed;
}

function normalizePromptText(value, fallback = '') {
  return String(value == null || value === '' ? fallback : value).replace(/\r\n/g, '\n');
}

function formatPromptFileValue(value, indent, fallback = '') {
  return normalizePromptText(value, fallback)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n');
}

function decideTrigger({ eventName, action, issue, label, comment, mappedNeedsInfo, rerunLabels, ignoreLabel }) {
  const issueState = String(issue?.state || '').toLowerCase();
  const currentLabels = (issue?.labels || []).map(item => labelName(item).toLowerCase());
  const rerunLabelSet = new Set(
    (rerunLabels || []).map(item => String(item || '').trim().toLowerCase()).filter(Boolean)
  );
  const normalizedIgnoreLabel = String(ignoreLabel || '').trim().toLowerCase();

  if (normalizedIgnoreLabel && currentLabels.includes(normalizedIgnoreLabel)) {
    return { shouldRun: false, skipReason: `ignore-label:${normalizedIgnoreLabel}` };
  }

  if (issueState && issueState !== 'open') {
    return { shouldRun: false, skipReason: 'issue is not open' };
  }

  if (eventName === 'workflow_dispatch') {
    return {
      shouldRun: true,
      triggerReason: TRIGGER_REASONS.manualDispatch,
      commentStrategy: 'replace_latest',
      rerunLabelToRemove: ''
    };
  }

  if (eventName === 'issues') {
    if (['opened', 'reopened', 'edited'].includes(action)) {
      return {
        shouldRun: true,
        triggerReason: TRIGGER_REASONS[action],
        commentStrategy: 'replace_latest',
        rerunLabelToRemove: ''
      };
    }

    const labeledName = labelName(label);
    if (action === 'labeled' && issueState === 'open' && rerunLabelSet.has(labeledName.toLowerCase())) {
      return {
        shouldRun: true,
        triggerReason: TRIGGER_REASONS.manualRerun,
        commentStrategy: 'replace_latest',
        rerunLabelToRemove: labeledName
      };
    }
  }

  if (eventName === 'issue_comment') {
    if (issueState !== 'open') {
      return { shouldRun: false, skipReason: 'issue is not open' };
    }

    const commenter = String(comment?.user?.login || '').toLowerCase();
    const issueAuthor = String(issue?.user?.login || '').toLowerCase();
    const needsInfoLabel = String(mappedNeedsInfo || 'needs-info').trim().toLowerCase();
    if (commenter && commenter === issueAuthor && currentLabels.includes(needsInfoLabel)) {
      return {
        shouldRun: true,
        triggerReason: TRIGGER_REASONS.authorReply,
        commentStrategy: 'new_comment',
        rerunLabelToRemove: ''
      };
    }
  }

  return { shouldRun: false, skipReason: 'event does not require issue analysis' };
}

function findExistingBotComment(comments, marker) {
  return [...(comments || [])].reverse().find(comment =>
    String(comment?.body || '').includes(marker) && String(comment?.user?.type || '') === 'Bot'
  );
}

function isBotAnalysisComment(comment, marker) {
  return String(comment?.body || '').includes(String(marker || '')) &&
    String(comment?.user?.type || '') === 'Bot';
}

function summarizeOpenIssues(issues, currentIssueNumber, limit, emptyText) {
  const candidates = (issues || [])
    .filter(issue => !issue.pull_request && issue.number !== currentIssueNumber)
    .slice(0, limit);

  const summary = candidates.length
    ? candidates.map(issue => {
        const labels = (issue.labels || []).map(labelName).filter(Boolean).join(', ');
        const body = String(issue.body || '').replace(/\s+/g, ' ').slice(0, 180);
        return `#${issue.number} | ${issue.title} | labels=[${labels}] | body=${body}`;
      }).join('\n')
    : emptyText;

  return { issueNumbers: candidates.map(issue => issue.number), summary };
}

function summarizeRecentComments(comments, limit, emptyText, marker = '') {
  const visibleComments = (comments || []).filter(comment => !isBotAnalysisComment(comment, marker));
  if (!visibleComments.length) return emptyText;
  return visibleComments.slice(-limit).map(comment => {
    const author = comment?.user?.login || 'unknown';
    const body = String(comment?.body || '').replace(/\s+/g, ' ').slice(0, 300);
    return `${author}: ${body}`;
  }).join('\n');
}

function lastPageNumber(linkHeader) {
  const match = String(linkHeader || '')
    .match(/<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  const page = match ? Number(match[1]) : 1;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

async function collectRecentComments({ firstPage, lastPage, limit, fetchPage, cachedPages = new Map(), includeComment = () => true, maxPages = 20 } = {}) {
  const requested = Number(limit);
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('recent comment limit must be a positive integer');
  }
  if (!firstPage || typeof fetchPage !== 'function') {
    throw new Error('first page and fetchPage are required');
  }
  if (typeof includeComment !== 'function') {
    throw new Error('includeComment must be a function');
  }
  if (!Number.isSafeInteger(Number(maxPages)) || Number(maxPages) < 1) {
    throw new Error('maxPages must be a positive integer');
  }

  const pageCache = cachedPages instanceof Map ? new Map(cachedPages) : new Map();
  pageCache.set(1, firstPage);
  let page = Number(lastPage);
  if (!Number.isSafeInteger(page) || page < 1) page = lastPageNumber(firstPage.headers?.link);

  const pages = [];
  let fetchedPages = 0;
  while (page >= 1 && fetchedPages < Number(maxPages)) {
    const response = pageCache.get(page) || await fetchPage(page);
    pages.unshift(Array.isArray(response?.data) ? response.data : []);
    fetchedPages += 1;
    if (pages.flat().filter(includeComment).length >= requested || page === 1) break;
    page -= 1;
  }

  return pages.flat().filter(includeComment).slice(-requested);
}

function discussionFingerprint(comments, marker = '', limit = 100) {
  const visibleComments = (comments || [])
    .filter(comment => !isBotAnalysisComment(comment, marker))
    .slice(-limit)
    .map(comment => ({
      id: Number(comment?.id || 0),
      author: String(comment?.user?.login || ''),
      createdAt: String(comment?.created_at || ''),
      updatedAt: String(comment?.updated_at || ''),
      body: String(comment?.body || '')
    }));

  return crypto.createHash('sha256').update(JSON.stringify(visibleComments)).digest('hex');
}

function managedLabelSet(labelMap = {}) {
  return new Set(
    MANAGED_CANONICAL_LABELS
      .map(name => String(labelMap[name] || name).trim().toLowerCase())
      .filter(Boolean)
  );
}

function managedLabelFingerprint(currentLabels, labelMap = {}) {
  const managedLabels = managedLabelSet(labelMap);
  const snapshot = (currentLabels || [])
    .map(labelName)
    .map(name => name.toLowerCase())
    .filter(name => managedLabels.has(name))
    .sort();

  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function normalizeManagedLabels(labels) {
  return Array.from(new Set(
    (labels || [])
      .map(labelName)
      .filter(Boolean)
      .slice(0, 100)
  ));
}

function retainPresentLabels(ownedLabels, currentLabels) {
  const currentByLower = new Map(
    normalizeManagedLabels(currentLabels).map(name => [name.toLowerCase(), name])
  );
  return normalizeManagedLabels(ownedLabels)
    .map(name => currentByLower.get(name.toLowerCase()))
    .filter(Boolean);
}

function renderManagedLabelsMarker(labels = []) {
  const payload = Buffer.from(JSON.stringify(normalizeManagedLabels(labels)), 'utf8').toString('base64url');
  return `<!-- issue-ai-analyze-managed-labels:${payload} -->`;
}

function parseManagedLabels(body) {
  const match = String(body || '')
    .match(/<!-- issue-ai-analyze-managed-labels:([A-Za-z0-9_-]+) -->/);
  if (!match) return [];

  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? normalizeManagedLabels(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeLabelPlan(plan = {}) {
  return {
    add: normalizeManagedLabels(plan.add),
    baseLabels: normalizeManagedLabels(plan.baseLabels),
    confirmed: plan.confirmed === true
  };
}

function renderLabelPlanMarker(plan = {}) {
  const normalized = normalizeLabelPlan(plan);
  if (normalized.add.length === 0) return '';
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  return `<!-- issue-ai-analyze-label-plan:${payload} -->`;
}

function parseLabelPlan(body) {
  const match = String(body || '')
    .match(/<!-- issue-ai-analyze-label-plan:([A-Za-z0-9_-]+) -->/);
  if (!match) return normalizeLabelPlan();

  try {
    return normalizeLabelPlan(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
  } catch {
    return normalizeLabelPlan();
  }
}

function recoverLabelPlanOwnership(plan, currentLabels) {
  const normalized = normalizeLabelPlan(plan);
  if (!normalized.confirmed) return [];
  const baseline = new Set(normalized.baseLabels.map(name => name.toLowerCase()));
  const currentByLower = new Map(
    normalizeManagedLabels(currentLabels).map(name => [name.toLowerCase(), name])
  );
  return normalized.add
    .filter(name => !baseline.has(name.toLowerCase()))
    .map(name => currentByLower.get(name.toLowerCase()))
    .filter(Boolean);
}

function upsertLabelPlanMarker(body, plan) {
  const withoutExisting = String(body || '')
    .replace(/<!-- issue-ai-analyze-label-plan:[A-Za-z0-9_-]+ -->\n?/g, '')
    .trimEnd();
  const marker = renderLabelPlanMarker(plan);
  return marker ? `${withoutExisting}\n${marker}` : withoutExisting;
}

function parseAiJson(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('empty-ai-response');

  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
    throw new Error('invalid-json-response');
  }
}

function safeString(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function normalizeAnalysis(parsed, { openIssueNumbers = [], labelMap = {}, language = {} } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid-ai-result-object');
  }

  const allowedCategories = new Set(['bug', 'question', 'enhancement', 'documentation']);
  const allowedDispositions = new Set(['duplicate', 'none']);
  const knownIssueNumbers = new Set(openIssueNumbers.map(Number));
  const mapLabel = name => safeString(labelMap[name] || name, 100);

  if (typeof parsed.summary !== 'string' ||
      typeof parsed.category !== 'string' ||
      typeof parsed.disposition !== 'string' ||
      typeof parsed.needsInfo !== 'boolean' ||
      typeof parsed.infoAssessment !== 'string' ||
      !Array.isArray(parsed.supplementSuggestions) ||
      parsed.supplementSuggestions.some(item => typeof item !== 'string') ||
      typeof parsed.titleSuggestion !== 'string' ||
      !(parsed.duplicateOf === null ||
        (typeof parsed.duplicateOf === 'number' && Number.isInteger(parsed.duplicateOf) && parsed.duplicateOf > 0)) ||
      typeof parsed.confidence !== 'number' ||
      !Number.isFinite(parsed.confidence)) {
    throw new Error('invalid-ai-result-shape');
  }

  const category = parsed.category.toLowerCase();
  const disposition = parsed.disposition.toLowerCase();
  if (!allowedCategories.has(category)) throw new Error('invalid-category');
  if (!allowedDispositions.has(disposition)) throw new Error('invalid-disposition');
  if (parsed.confidence < 0 || parsed.confidence > 1) throw new Error('invalid-confidence');

  const result = {
    summary: safeString(parsed.summary, 180) || String(
      language.normalize_summary_fallback ||
      'Automatic analysis completed, but maintainers should still review the context before making a final decision.'
    ),
    category,
    disposition,
    needsInfo: parsed.needsInfo,
    infoAssessment: safeString(parsed.infoAssessment, 220) || String(
      language.normalize_info_fallback || 'The current information appears sufficient for an initial analysis.'
    ),
    supplementSuggestions: parsed.supplementSuggestions
      .map(item => safeString(item, 120)).filter(Boolean).slice(0, 3),
    titleSuggestion: safeString(parsed.titleSuggestion, 120),
    duplicateOf: parsed.duplicateOf,
    confidence: parsed.confidence
  };

  if (result.disposition !== 'none') {
    result.needsInfo = false;
    result.supplementSuggestions = [];
  }

  if (result.disposition === 'duplicate') {
    if (!Number.isFinite(result.duplicateOf) || !knownIssueNumbers.has(result.duplicateOf)) {
      result.disposition = 'none';
      result.duplicateOf = null;
    } else {
      result.infoAssessment = safeString(language.normalize_duplicate_info, 220) ||
        'The current information is sufficient to identify this as a duplicate, and no extra details are required.';
    }
  } else {
    result.duplicateOf = null;
  }

  const canonicalLabels = result.disposition !== 'none'
    ? [result.disposition]
    : [result.category, ...(result.needsInfo ? ['needs-info'] : [])];
  result.canonicalLabels = canonicalLabels;
  result.labels = Array.from(new Set(canonicalLabels.map(mapLabel).filter(Boolean)));
  return result;
}

function computeLabelChanges(currentLabels, desiredLabels, labelMap = {}, policy = 'replace', ownedLabels = null) {
  const managedLabels = managedLabelSet(labelMap);
  const removableLabels = ownedLabels == null
    ? managedLabels
    : new Set(normalizeManagedLabels(ownedLabels)
      .map(name => name.toLowerCase())
      .filter(name => managedLabels.has(name)));
  const desiredByLower = new Map(
    (desiredLabels || [])
      .map(label => String(label || '').trim())
      .filter(Boolean)
      .map(label => [label.toLowerCase(), label])
  );
  const current = (currentLabels || []).map(labelName).filter(Boolean);

  return {
    remove: policy === 'replace'
      ? current.filter(name => removableLabels.has(name.toLowerCase()) && !desiredByLower.has(name.toLowerCase()))
      : [],
    add: policy === 'none'
      ? []
      : [...desiredByLower.entries()]
        .filter(([lower]) => !current.some(existing => existing.toLowerCase() === lower))
        .map(([, name]) => name)
  };
}

function formatRerunLabels(labels, languageCode) {
  const items = (labels || []).map(label => `\`${label}\``);
  if (items.length === 0) return '`ai-rerun`';
  if (items.length === 1) return items[0];
  if (languageCode === 'zh') return items.join('、');
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

function renderTemplate(value, rerunLabels, languageCode) {
  return String(value || '').replace(
    /\{\{rerun_labels\}\}/g,
    formatRerunLabels(rerunLabels, languageCode)
  );
}

function sanitizeCommentText(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/@(?=[A-Za-z0-9_])/g, '@\u200b');
}

function renderAnalysisComment({ result, issueTitle, language = {}, rerunLabels = [], commentMarker, runMarker = '', labelManagement = 'replace', labelSyncStatus = 'applied', managedLabels = [], labelPlan = null }) {
  const t = (key, fallback = '') => String(language[key] || fallback);
  const display = value => sanitizeCommentText(value);
  const syncNote = labelSyncStatus === 'failed'
    ? t('sync_note_failed', 'Analysis completed, but label synchronization did not fully succeed. Please review the workflow log and labels manually.')
    : labelSyncStatus === 'conflict'
      ? t('sync_note_conflict', 'A maintainer changed an AI-managed label during analysis, so this run did not overwrite that manual change.')
      : ['not-applied', 'stale', 'ignored'].includes(labelSyncStatus)
        ? t('sync_note_not_applied', 'Analysis completed, but label synchronization did not finish. Please review the labels manually.')
        : labelManagement === 'none'
          ? t('sync_note_none', 'These labels are suggestions only; no issue labels were changed.')
          : labelManagement === 'add-only'
            ? t('sync_note_add_only', 'Suggested labels were added where missing; existing labels were preserved.')
            : t('sync_note', 'The suggested labels above have already been synced to this issue. Developers can still adjust them manually.');
  const lines = [
    t('analysis_title', '## 🤖 AI Initial Analysis'),
    '',
    `- **${t('summary_label', 'Summary')}**: ${display(result.summary)}`,
    `- **${t('suggested_labels_label', 'Suggested labels')}**: ${result.labels.map(label => `\`${label}\``).join(' ') || t('comment_none_label', '(none)')}`,
    `- **${t('suggested_title_label', 'Suggested title')}**: ${display(result.titleSuggestion || issueTitle)}`,
    `- **${t('info_assessment_label', 'Information assessment')}**: ${display(result.infoAssessment)}`,
    `- **${t('confidence_label', 'Confidence')}**: ${Math.round(Number(result.confidence || 0) * 100)}%`
  ];

  if (result.duplicateOf) {
    lines.push(`- **${t('duplicate_of_label', 'Possible duplicate of')}**: #${result.duplicateOf}`);
  }

  if (Array.isArray(result.supplementSuggestions) && result.supplementSuggestions.length > 0) {
    lines.push('', result.needsInfo
      ? t('suggestions_heading_needed', '### Suggested follow-up')
      : t('suggestions_heading_optional', '### Optional follow-up'));
    for (const item of result.supplementSuggestions) lines.push(`- ${display(item)}`);
  }

  lines.push(
    '',
    syncNote,
    t('rerun_intro', 'If more information is added later:'),
    t('rerun_needs_info', '- When the issue author replies while `needs-info` is present, I will rerun automatically.'),
    renderTemplate(
      t('rerun_manual_template', '- Developers can add label {{rerun_labels}} to rerun manually.'),
      rerunLabels,
      String(language.code || 'en')
    ),
    '',
    renderManagedLabelsMarker(managedLabels),
    ...(labelPlan && renderLabelPlanMarker(labelPlan) ? [renderLabelPlanMarker(labelPlan)] : []),
    ...(runMarker ? [runMarker] : []),
    commentMarker
  );
  return lines.join('\n');
}

function renderFallbackComment({ reason, language = {}, rerunLabels = [], commentMarker, runMarker = '', managedLabels = [], labelPlan = null }) {
  const t = (key, fallback = '') => String(language[key] || fallback);
  const diagnostic = sanitizeCommentText(String(reason || 'unknown-error').slice(0, 1000));
  return [
    t('fallback_title', '## ⚠️ AI Analysis Failed'),
    '',
    t('fallback_body', 'This automatic analysis did not complete successfully. The cause may be model access failure, invalid output format, or a temporary network problem.'),
    `- **${t('diagnostic_label', 'Diagnostic')}**: \`${diagnostic}\``,
    '',
    renderTemplate(
      t('fallback_retry_template', 'You can edit the issue later, or add label {{rerun_labels}} to try again.'),
      rerunLabels,
      String(language.code || 'en')
    ),
    t('fallback_manual', 'Developers can also apply labels manually without blocking normal issue handling.'),
    '',
    renderManagedLabelsMarker(managedLabels),
    ...(labelPlan && renderLabelPlanMarker(labelPlan) ? [renderLabelPlanMarker(labelPlan)] : []),
    ...(runMarker ? [runMarker] : []),
    commentMarker
  ].join('\n');
}

function renderStaleComment({ language = {}, commentMarker, runMarker = '', reason = '', managedLabels = [], labelPlan = null }) {
  const t = (key, fallback = '') => String(language[key] || fallback);
  const bodyKey = reason === 'issue-changed-during-analysis'
    ? 'stale_body_changed'
    : reason === 'discussion-changed-during-analysis'
      ? 'stale_body_discussion'
    : reason === 'issue-not-open'
      ? 'stale_body_closed'
      : reason === 'freshness-check-failed'
        ? 'stale_body_verification_failed'
        : String(reason || '').startsWith('ignore-label:')
          ? 'stale_body_ignore'
          : 'stale_body';
  return [
    t('stale_title', '## ⚠️ AI Analysis Not Applied'),
    '',
    t(bodyKey, t('stale_body', 'The issue changed during analysis or was marked to skip AI. This result was not applied.')),
    '',
    t('fallback_manual', 'Developers can continue handling the issue manually.'),
    '',
    renderManagedLabelsMarker(managedLabels),
    ...(labelPlan && renderLabelPlanMarker(labelPlan) ? [renderLabelPlanMarker(labelPlan)] : []),
    ...(runMarker ? [runMarker] : []),
    commentMarker
  ].join('\n');
}

function decideFinalComment({ normalizeOk, freshnessOk, freshnessReason = '', normalizeError = '', jobStatus = '', inferenceOutcome = '', labelSyncStatus = '' } = {}) {
  if (normalizeOk !== 'true') {
    const cancelled = String(jobStatus || '').toLowerCase() === 'cancelled' ||
      String(inferenceOutcome || '').toLowerCase() === 'cancelled';
    return {
      kind: 'fallback',
      reason: cancelled ? 'analysis-cancelled' : String(normalizeError || 'analysis-incomplete').slice(0, 1000)
    };
  }

  if (freshnessOk !== 'true') {
    return {
      kind: 'stale',
      reason: String(freshnessReason || 'freshness-check-failed')
    };
  }

  return {
    kind: 'analysis',
    labelSyncStatus: String(labelSyncStatus || 'not-applied')
  };
}

function issueFingerprint(issue) {
  return crypto.createHash('sha256').update(JSON.stringify({
    title: String(issue?.title || ''),
    body: String(issue?.body || '')
  })).digest('hex');
}

module.exports = {
  collectRecentComments,
  computeLabelChanges,
  discussionFingerprint,
  decideTrigger,
  findExistingBotComment,
  formatPromptFileValue,
  formatRerunLabels,
  decideFinalComment,
  isBotAnalysisComment,
  issueFingerprint,
  labelName,
  lastPageNumber,
  managedLabelFingerprint,
  normalizeLabelPlan,
  parseManagedLabels,
  parseLabelPlan,
  recoverLabelPlanOwnership,
  renderLabelPlanMarker,
  renderManagedLabelsMarker,
  normalizeAnalysis,
  normalizeLimit,
  normalizePromptText,
  parseAiJson,
  renderAnalysisComment,
  renderFallbackComment,
  renderStaleComment,
  renderTemplate,
  retainPresentLabels,
  sanitizeCommentText,
  safeString,
  summarizeOpenIssues,
  summarizeRecentComments,
  upsertLabelPlanMarker
};
