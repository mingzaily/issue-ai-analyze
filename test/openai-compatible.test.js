'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repository = path.join(__dirname, '..');
const client = path.join(repository, 'src', 'openai_compatible.rb');

const prompt = `messages:
  - role: system
    content: Return only JSON.
  - role: user
    content: |
      Trigger: {{trigger_reason}}
      Title: {{issue_title}}
      Body: {{issue_body}}
responseFormat: json_schema
jsonSchema:
  '{"name":"issue_analysis_result","strict":true,"schema":{"type":"object","additionalProperties":false,"properties":{"category":{"type":"string"}},"required":["category"]}}'
model: deepseek-v4-flash
modelParameters:
  temperature: 0.0
  maxCompletionTokens: 64
`;

function startServer(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      const entry = {
        headers: request.headers,
        method: request.method,
        path: request.url,
        body: JSON.parse(raw),
        response
      };
      requests.push(entry);
      try {
        await handler(entry, requests.length);
      } catch (error) {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { message: error.message } }));
        return;
      }
      if (!response.writableEnded) {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: '{"category":"bug"}' } }] }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        requests,
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done()))
      });
    });
  });
}

function sendJson(response, status, body, headers = {}) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

async function runClient({ server, responseFormat = 'auto', headers = {}, model = 'deepseek-v4-flash' } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-ai-analyze-openai-'));
  const outputFile = path.join(tempDir, 'github-output');
  const promptFile = path.join(tempDir, 'prompt.yml');
  const issueTitleFile = path.join(tempDir, 'issue-title');
  const issueBodyFile = path.join(tempDir, 'issue-body');
  fs.writeFileSync(outputFile, '');
  fs.writeFileSync(promptFile, prompt);
  fs.writeFileSync(issueTitleFile, 'Packy compatibility');
  fs.writeFileSync(issueBodyFile, 'The upstream endpoint should return JSON.');

  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputFile,
    GITHUB_RUN_ID: 'test-run',
    RUNNER_TEMP: tempDir,
    OPENAI_COMPAT_ENDPOINT: server.url,
    OPENAI_COMPAT_TOKEN: 'test-token',
    OPENAI_COMPAT_HEADERS_JSON: JSON.stringify(headers),
    OPENAI_COMPAT_RESPONSE_FORMAT: responseFormat,
    PROMPT_FILE: promptFile,
    MODEL: model,
    MODEL_PARAMETERS_JSON: JSON.stringify({ temperature: 0, maxCompletionTokens: 64 }),
    TRIGGER_REASON: 'issue opened',
    ISSUE_TITLE_FILE: issueTitleFile,
    CURRENT_LABELS_FILE: '',
    ISSUE_BODY_FILE: issueBodyFile,
    RECENT_COMMENTS_FILE: '',
    OPEN_ISSUES_FILE: ''
  };

  const result = await new Promise((resolve, reject) => {
    const child = childProcess.spawn('ruby', [client], {
      cwd: repository,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });

  const outputs = Object.fromEntries(
    fs.readFileSync(outputFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })
  );
  const responseContent = outputs['response-file'] && fs.existsSync(outputs['response-file'])
    ? fs.readFileSync(outputs['response-file'], 'utf8')
    : '';
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { ...result, outputs, responseContent };
}

test('custom client sends json_schema and forwards validated headers', async () => {
  const server = await startServer((_request, _count) => {});
  const result = await runClient({
    server,
    responseFormat: 'json_schema',
    headers: { 'X-Packy-Trace': 'test-trace' }
  });
  await server.close();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].path, '/v1/chat/completions');
  assert.equal(server.requests[0].headers.authorization, 'Bearer test-token');
  assert.equal(server.requests[0].headers['x-packy-trace'], 'test-trace');
  assert.equal(server.requests[0].body.model, 'deepseek-v4-flash');
  assert.equal(server.requests[0].body.max_tokens, 64);
  assert.equal(server.requests[0].body.response_format.type, 'json_schema');
  assert.equal(server.requests[0].body.response_format.json_schema.name, 'issue_analysis_result');
  assert.equal(result.outputs['response-mode'], 'json_schema');
  assert.equal(result.responseContent, '{"category":"bug"}');
});

test('auto mode falls back from json_schema to json_object when the upstream rejects it', async () => {
  const server = await startServer((request, count) => {
    if (count === 1) {
      assert.equal(request.body.response_format.type, 'json_schema');
      sendJson(request.response, 400, { error: { message: 'This response_format type is unavailable now' } }, { 'x-request-id': 'packy-400' });
    }
  });
  const result = await runClient({ server });
  await server.close();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[1].body.response_format.type, 'json_object');
  assert.match(server.requests[1].body.messages[0].content, /Compatibility transport constraint/);
  assert.equal(result.outputs['response-mode'], 'json_object');
  assert.equal(result.responseContent, '{"category":"bug"}');
});

test('auto mode reaches prompt-only JSON when the provider rejects both structured formats', async () => {
  const server = await startServer((request, count) => {
    if (count < 3) {
      sendJson(request.response, 400, { error: { message: 'response_format is not supported' } });
    }
  });
  const result = await runClient({ server });
  await server.close();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 3);
  assert.equal(server.requests[0].body.response_format.type, 'json_schema');
  assert.equal(server.requests[1].body.response_format.type, 'json_object');
  assert.equal('response_format' in server.requests[2].body, false);
  assert.match(server.requests[2].body.messages[0].content, /JSON Schema/);
  assert.equal(result.outputs['response-mode'], 'prompt');
});

test('prompt mode omits response_format and adds a JSON-only system constraint', async () => {
  const server = await startServer((_request, _count) => {});
  const result = await runClient({ server, responseFormat: 'prompt' });
  await server.close();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.equal('response_format' in server.requests[0].body, false);
  assert.match(server.requests[0].body.messages[0].content, /Compatibility transport constraint/);
  assert.equal(result.outputs['response-mode'], 'prompt');
});

for (const status of [400, 401, 404]) {
  test(`surfaces upstream HTTP ${status} errors instead of reporting only a missing response file`, async () => {
    const server = await startServer((request, _count) => {
      sendJson(request.response, status, { error: { message: status === 400 ? 'invalid model' : 'authentication or route failure' } });
    });
    const result = await runClient({ server });
    await server.close();

    assert.notEqual(result.code, 0);
    assert.match(result.outputs.error, new RegExp(`openai-compatible-http-${status}`));
    assert.equal(result.outputs['response-file'], '');
    assert.doesNotMatch(result.outputs.error, /missing-ai-response-file/);
  });
}
