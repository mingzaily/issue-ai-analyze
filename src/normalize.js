'use strict';

module.exports = async function run({ github, context, core }) {
const fs = require('fs');
const path = require('path');
const actionCore = require(path.join(process.env.ACTION_PATH, 'src', 'core.js'));

const fail = (message) => {
  core.setOutput('ok', 'false');
  core.setOutput('error', String(message || 'unknown-error').slice(0, 1000));
};
try {
  const responseFile = String(process.env.AI_RESPONSE_FILE || '').trim();
  if (!responseFile) {
    fail('missing-ai-response-file');
    return;
  }

  const raw = fs.readFileSync(responseFile, 'utf8');
  const parsed = actionCore.parseAiJson(raw);
  const openIssueNumbers = JSON.parse(process.env.OPEN_ISSUE_NUMBERS || '[]');
  const labelMap = JSON.parse(process.env.LABEL_MAP_JSON || '{}');
  const language = JSON.parse(process.env.LANGUAGE_PROFILE_JSON || '{}');
  const result = actionCore.normalizeAnalysis(parsed, { openIssueNumbers, labelMap, language });

  core.setOutput('ok', 'true');
  core.setOutput('json', JSON.stringify(result));
  core.setOutput('labels', JSON.stringify(result.labels));
  core.setOutput('category', result.category);
  core.setOutput('disposition', result.disposition);
  core.setOutput('needs_info', result.needsInfo ? 'true' : 'false');
  core.setOutput('error', '');
} catch (error) {
  fail(error.message || error);
}
};
