/**
 * AutoPR Action — Unit Tests
 *
 * These tests mock @actions/core, @actions/github, node-fetch, and fs
 * to exercise the Action logic without hitting real APIs.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSetFailed = jest.fn();
const mockInfo = jest.fn();
const mockWarning = jest.fn();
const mockGetInput = jest.fn();

jest.mock('@actions/core', () => ({
  getInput: (...args) => mockGetInput(...args),
  setFailed: (...args) => mockSetFailed(...args),
  info: (...args) => mockInfo(...args),
  warning: (...args) => mockWarning(...args),
}));

const mockOctokit = {
  rest: {
    pulls: {
      get: jest.fn(),
      update: jest.fn(),
    },
  },
};

const mockGetOctokit = jest.fn(() => mockOctokit);

// Default github context (non-fork, public repo)
const defaultGithubContext = {
  repo: { owner: 'test-owner', repo: 'test-repo' },
  payload: {
    pull_request: {
      number: 42,
      head: { repo: { full_name: 'test-owner/test-repo' } },
      base: { repo: { full_name: 'test-owner/test-repo' } },
    },
    repository: { private: false },
  },
};

jest.mock('@actions/github', () => ({
  context: defaultGithubContext,
  getOctokit: (...args) => mockGetOctokit(...args),
}));

// Mock global fetch
global.fetch = jest.fn();

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInputs({
  openai_key = 'sk-test',
  license_key = '',
  model = 'gpt-4o-mini',
  max_diff_lines = '500',
  skip_if_body_set = 'true',
  template = '',
} = {}) {
  mockGetInput.mockImplementation((name, opts) => {
    const map = { openai_key, license_key, model, max_diff_lines, skip_if_body_set, template };
    return map[name] ?? '';
  });
}

function makePR({ body = '', isPrivate = false } = {}) {
  return {
    data: {
      number: 42,
      title: 'feat: add new widget',
      body,
      head: { repo: { full_name: 'test-owner/test-repo' } },
      base: { repo: { private: isPrivate, full_name: 'test-owner/test-repo' } },
    },
  };
}

function makeDiff(lines = 10) {
  return {
    data: Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n'),
  };
}

function mockOpenAISuccess(content = '## Summary\nDid stuff.') {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

function mockOpenAIError(status = 500, text = 'Internal error') {
  global.fetch.mockResolvedValueOnce({
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => text,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GITHUB_TOKEN = 'ghp_test';
});

// Helper: load and re-execute index.js fresh each test
async function runAction(githubContextOverride = null) {
  jest.resetModules();
  const contextToUse = githubContextOverride || defaultGithubContext;
  // Re-apply mocks after resetModules
  jest.mock('@actions/core', () => ({
    getInput: (...args) => mockGetInput(...args),
    setFailed: (...args) => mockSetFailed(...args),
    info: (...args) => mockInfo(...args),
    warning: (...args) => mockWarning(...args),
  }));
  jest.mock('@actions/github', () => ({
    context: contextToUse,
    getOctokit: (...args) => mockGetOctokit(...args),
  }));
  const mod = require('../src/index.js');
  // index.js calls run() immediately; just wait a tick
  await new Promise(r => setImmediate(r));
}

// 1. skip_if_body_set: true + PR has long body → skip
test('skips PR update when body already set and skip_if_body_set=true', async () => {
  makeInputs({ skip_if_body_set: 'true' });
  mockOctokit.rest.pulls.get.mockResolvedValue(makePR({ body: 'This is a real, meaningful description that clearly explains the change in detail.' }));
  await runAction();
  expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('meaningful description'));
  expect(mockOctokit.rest.pulls.update).not.toHaveBeenCalled();
});

// 2. skip_if_body_set: true + PR body short → don't skip
test('does not skip when existing body is short', async () => {
  makeInputs({ skip_if_body_set: 'true' });
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR({ body: 'Short.' }))  // first get (PR)
    .mockResolvedValueOnce(makeDiff(5));                 // second get (diff)
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
});

// 3. skip_if_body_set: false → never skip regardless of body length
test('does not skip when skip_if_body_set=false even with long body', async () => {
  makeInputs({ skip_if_body_set: 'false' });
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR({ body: 'This is a real, meaningful description that is definitely long enough to qualify.' }))
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
});

// 3b. skip_if_body_set: true + body looks like a template → don't skip
test('does not skip when body is a PR template placeholder', async () => {
  makeInputs({ skip_if_body_set: 'true' });
  const templateBody = '## Describe your changes\n\n## What type of PR is this?\n\n## Checklist\n';
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR({ body: templateBody }))
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
});

// 4. diff truncation: diff > max_diff_lines gets truncated
test('truncates diff when it exceeds max_diff_lines', async () => {
  makeInputs({ max_diff_lines: '3' });
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce({ data: 'line1\nline2\nline3\nline4\nline5' });
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  const openaiCall = global.fetch.mock.calls.find(c => c[0].includes('openai'));
  const body = JSON.parse(openaiCall[1].body);
  const userMsg = body.messages.find(m => m.role === 'user').content;
  expect(userMsg).toContain('Diff truncated at 3 lines');
});

// 5. diff within max_diff_lines → no truncation notice
test('does not truncate diff within max_diff_lines', async () => {
  makeInputs({ max_diff_lines: '500' });
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  const openaiCall = global.fetch.mock.calls.find(c => c[0].includes('openai'));
  const body = JSON.parse(openaiCall[1].body);
  const userMsg = body.messages.find(m => m.role === 'user').content;
  expect(userMsg).not.toContain('Diff truncated');
});

// 6. private repo without license key → setFailed
test('fails on private repo without license key', async () => {
  makeInputs({ license_key: '' });
  // context.payload.repository.private = true triggers the check
  const privateContext = {
    ...defaultGithubContext,
    payload: {
      ...defaultGithubContext.payload,
      repository: { private: true },
    },
  };
  mockOctokit.rest.pulls.get.mockResolvedValue(makePR({ isPrivate: true }));
  await runAction(privateContext);
  expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('private repo requires a license key'));
  expect(mockOctokit.rest.pulls.update).not.toHaveBeenCalled();
});

// 7. private repo with valid license key → proceeds
test('proceeds on private repo with valid license key', async () => {
  makeInputs({ license_key: 'autopr_validkey123' });
  const privateContext = {
    ...defaultGithubContext,
    payload: {
      ...defaultGithubContext.payload,
      repository: { private: true },
    },
  };
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR({ isPrivate: true }))
    .mockResolvedValueOnce(makeDiff(5));
  // License validation call
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ valid: true }),
  });
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction(privateContext);
  expect(mockSetFailed).not.toHaveBeenCalled();
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
});

// 8. private repo with invalid license key → setFailed
test('fails on private repo with invalid license key', async () => {
  makeInputs({ license_key: 'autopr_badkey' });
  const privateContext = {
    ...defaultGithubContext,
    payload: {
      ...defaultGithubContext.payload,
      repository: { private: true },
    },
  };
  mockOctokit.rest.pulls.get.mockResolvedValue(makePR({ isPrivate: true }));
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ valid: false, message: 'License not found.' }),
  });
  await runAction(privateContext);
  expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('invalid license key'));
});

// 9. public repo without license key → passes license check
test('public repo without license key skips validation entirely', async () => {
  makeInputs({ license_key: '' });
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR({ isPrivate: false }))
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  // No license validation fetch should happen (only OpenAI call)
  const licenseFetch = global.fetch.mock.calls.find(c => c[0].includes('validate-autopr'));
  expect(licenseFetch).toBeUndefined();
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
});

// 10. license validation network failure → fail-open (warning, not error)
test('continues fail-open when license validation network fails', async () => {
  makeInputs({ license_key: 'autopr_somekey' });
  const privateContext = {
    ...defaultGithubContext,
    payload: {
      ...defaultGithubContext.payload,
      repository: { private: true },
    },
  };
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR({ isPrivate: true }))
    .mockResolvedValueOnce(makeDiff(5));
  global.fetch.mockRejectedValueOnce(new Error('Network timeout'));
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction(privateContext);
  expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('license validation failed'));
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
});

// 11. empty diff → still calls OpenAI with empty diff
test('handles empty diff gracefully', async () => {
  makeInputs();
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce({ data: '' });
  mockOpenAISuccess('## Summary\nEmpty diff.');
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
  expect(mockSetFailed).not.toHaveBeenCalled();
});

// 12. OpenAI error → setFailed
test('fails when OpenAI returns an error', async () => {
  makeInputs();
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAIError(500, 'Internal server error');
  await runAction();
  expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('OpenAI API error'));
});

// 13. OpenAI returns empty content → setFailed
test('fails when OpenAI returns empty content', async () => {
  makeInputs();
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce(makeDiff(5));
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  });
  await runAction();
  expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('empty response'));
});

// 14. template loading: valid template file → included in prompt
test('includes template content in OpenAI system prompt', async () => {
  const fs = require('fs');
  jest.spyOn(fs, 'readFileSync').mockReturnValue('## Context\nDescribe the why.\n## Impact\nNote affected users.');
  makeInputs({ template: '.github/PULL_REQUEST_TEMPLATE.md' });
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  const openaiCall = global.fetch.mock.calls.find(c => c[0].includes('openai'));
  const body = JSON.parse(openaiCall[1].body);
  const sysMsg = body.messages.find(m => m.role === 'system').content;
  expect(sysMsg).toContain('Describe the why');
  fs.readFileSync.mockRestore();
});

// 15. template loading: file not found → warning, continues without template
test('warns and continues when template file is missing', async () => {
  const fs = require('fs');
  jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT: no such file'); });
  makeInputs({ template: '.github/MISSING.md' });
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('could not read template file'));
  expect(mockOctokit.rest.pulls.update).toHaveBeenCalled();
  fs.readFileSync.mockRestore();
});

// 16. no pull_request in context → skip with info
test('skips gracefully when no pull request in context', async () => {
  const noprContext = {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    payload: {},  // no pull_request
  };
  makeInputs();
  await runAction(noprContext);
  expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('No pull request'));
  expect(mockOctokit.rest.pulls.update).not.toHaveBeenCalled();
});

// 17. footer appended to generated body
test('appends AutoPR footer to generated description', async () => {
  makeInputs();
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce(makeDiff(5));
  mockOpenAISuccess('## Summary\nSome content.');
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  const updateCall = mockOctokit.rest.pulls.update.mock.calls[0][0];
  expect(updateCall.body).toContain('Generated by [AutoPR]');
  expect(updateCall.body).toContain('autopr.dev');
});

// 18. Fork PR → skips with info message (Fix 1)
test('skips when PR is from a forked repo', async () => {
  const forkContext = {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    payload: {
      pull_request: {
        number: 42,
        head: { repo: { full_name: 'contributor/test-repo' } },
        base: { repo: { full_name: 'test-owner/test-repo' } },
      },
      repository: { private: false },
    },
  };
  makeInputs();
  await runAction(forkContext);
  expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('PR is from a fork'));
  expect(mockOctokit.rest.pulls.update).not.toHaveBeenCalled();
});

// 19. Binary file lines stripped from diff (Fix 6)
test('strips binary file lines from diff before sending to OpenAI', async () => {
  makeInputs();
  const diffWithBinary = '+line 1\nBinary files a/image.png and b/image.png differ\n+line 2\nBinary files a/doc.pdf and b/doc.pdf differ\n+line 3';
  mockOctokit.rest.pulls.get
    .mockResolvedValueOnce(makePR())
    .mockResolvedValueOnce({ data: diffWithBinary });
  mockOpenAISuccess();
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  await runAction();
  const openaiCall = global.fetch.mock.calls.find(c => c[0].includes('openai'));
  const body = JSON.parse(openaiCall[1].body);
  const userMsg = body.messages.find(m => m.role === 'user').content;
  expect(userMsg).not.toContain('Binary files');
  expect(userMsg).toContain('+line 1');
  expect(userMsg).toContain('+line 3');
});

// 20. isPrivate check uses context.payload.repository.private (Fix 2)
test('uses context.payload.repository.private for isPrivate check', async () => {
  makeInputs({ license_key: '' });
  // Simulate: context says repo is private, but PR head repo says public
  // The fix ensures we use context.payload.repository.private
  const privateBaseContext = {
    ...defaultGithubContext,
    payload: {
      ...defaultGithubContext.payload,
      repository: { private: true },  // base repo is private
    },
  };
  // PR head says public (old buggy behavior would use this)
  mockOctokit.rest.pulls.get.mockResolvedValue(makePR({ isPrivate: false }));
  await runAction(privateBaseContext);
  // Should fail because context.payload.repository.private = true and no license key
  expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('private repo requires a license key'));
});
