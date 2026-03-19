const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');

const WORKER_URL = 'https://api.difflog.io/validate-autopr';

// Fix 3: OpenAI retry on 429 and 5xx with exponential backoff
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    const shouldRetry = (res.status === 429 || res.status >= 500) && attempt < maxRetries;
    if (shouldRetry) {
      const retryAfter = res.status === 429
        ? parseInt(res.headers.get('retry-after') || '10', 10)
        : Math.pow(2, attempt); // exponential: 2s, 4s
      const label = res.status === 429 ? 'rate limited' : `server error ${res.status}`;
      core.warning(`AutoPR: OpenAI ${label}. Retrying in ${retryAfter}s (attempt ${attempt}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return res;
  }
  throw new Error('fetchWithRetry: exhausted all retries without returning a response');
}

// Fix 5: Detect if PR body is just a template placeholder
const bodyIsMeaningful = (body) => {
  if (!body || body.trim().length <= 30) return false;
  // Skip if body is just template placeholders
  const templateMarkers = ['## describe your changes', '## what type of pr', '<!-- ', '**type of change**'];
  const lower = body.toLowerCase().trim();
  const isOnlyTemplate = templateMarkers.some(m => lower.startsWith(m)) || lower.split('\n').every(l => l.startsWith('#') || l.startsWith('<!--') || l.trim() === '');
  return !isOnlyTemplate;
};

async function run() {
  try {
    const openaiKey = core.getInput('openai_key', { required: true });
    const licenseKey = core.getInput('license_key') || '';
    const model = core.getInput('model') || 'gpt-4o-mini';
    const maxDiffLines = parseInt(core.getInput('max_diff_lines') || '500', 10);
    const safeDiffLines = (isNaN(maxDiffLines) || maxDiffLines <= 0) ? 500 : maxDiffLines;
    const skipIfBodySet = core.getInput('skip_if_body_set') !== 'false';
    const template = core.getInput('template') || '';

    const context = github.context;
    const { owner, repo } = context.repo;
    const pullNumber = context.payload.pull_request?.number;

    if (!pullNumber) {
      core.info('No pull request found in context. Skipping.');
      return;
    }

    // Fix 1: Skip fork PRs — GITHUB_TOKEN is read-only for cross-repo PRs
    const prPayload = context.payload.pull_request;
    const headFullName = prPayload?.head?.repo?.full_name;
    const baseFullName = prPayload?.base?.repo?.full_name;
    if (headFullName && baseFullName && headFullName !== baseFullName) {
      core.info('AutoPR: PR is from a fork — skipping (GITHUB_TOKEN is read-only for fork PRs).');
      return;
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.setFailed('AutoPR: GITHUB_TOKEN is not set. Add `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to your workflow step. See https://autopr.dev for setup instructions.');
      return;
    }
    const octokit = github.getOctokit(githubToken);

    // Get the PR
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });

    // Fix 5: Skip if body already set and meaningful
    if (skipIfBodySet && bodyIsMeaningful(pr.body)) {
      core.info('PR already has a meaningful description. Skipping (skip_if_body_set=true).');
      return;
    }

    // Fix 2: Check if repo is private using context.payload.repository (the base repo)
    const isPrivate = context.payload.repository?.private ?? pr.base?.repo?.private ?? false;
    if (isPrivate) {
      if (!licenseKey) {
        core.setFailed('AutoPR: private repo requires a license key. Get one at autopr.dev');
        return;
      }
      // Validate license
      try {
        const validateRes = await fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ license_key: licenseKey, repo: `${owner}/${repo}` })
        });
        const validateData = await validateRes.json();
        if (!validateData.valid) {
          core.setFailed(`AutoPR: invalid license key. ${validateData.message || ''}`);
          return;
        }
      } catch (err) {
        core.warning(`AutoPR: license validation failed (${err.message}). Continuing anyway (fail-open).`);
      }
    }

    // Fetch the diff
    const { data: diff } = await octokit.rest.pulls.get({
      owner, repo, pull_number: pullNumber,
      mediaType: { format: 'diff' }
    });

    // Truncate diff
    const diffLines = String(diff).split('\n');
    let diffText = diffLines.slice(0, safeDiffLines).join('\n');
    if (diffLines.length > safeDiffLines) {
      diffText += `\n\n[Diff truncated at ${safeDiffLines} lines — this is a large PR. Consider splitting.]`;
    }

    // Fix 6: Strip binary file lines — they waste tokens and confuse GPT
    diffText = diffText.split('\n').filter(line => !line.startsWith('Binary files')).join('\n');

    // Load template if provided
    let templateContent = '';
    if (template) {
      try {
        templateContent = fs.readFileSync(template, 'utf8');
      } catch (e) {
        core.warning(`AutoPR: could not read template file ${template}: ${e.message}`);
      }
    }

    // Build prompt
    const systemPrompt = `You are a senior software engineer writing pull request descriptions for code review. Given a git diff, write a description that helps reviewers understand what changed, why it changed, and what to verify.

Rules:
- Be specific. Don't restate commit messages — explain the intent behind the change.
- Infer context from the diff. If auth files changed, mention session or security implications. If tests changed, note what behavior is now verified.
- The Summary should answer "what problem does this solve?" in 2-3 sentences.
- Testing notes should tell a reviewer exactly what to check — not generic advice.
- Drop sections that don't apply. A chores-only PR doesn't need a "New features" section.
- Never use filler phrases like "This PR updates..." or "Changes were made to..."
- Write as if explaining to a teammate in a code review, not a manager in a status update.

Format:
## Summary
[2-3 sentences: what changed and why]

## Changes
[Grouped bullets. Only include sections that apply:]
- **Breaking changes:** (if any)
- **New features:** (if any)
- **Bug fixes:** (if any)
- **Refactors:** (if any)
- **Chores:** (if any)

## Testing notes
[Specific, actionable things to verify. Reference actual file paths or function names from the diff.]

## Affected areas
[List of modules/directories touched]

${templateContent ? `\nUse this PR template as a guide for structure:\n${templateContent}` : ''}`;

    const userPrompt = `PR title: ${pr.title}\n\nDiff:\n${diffText}`;

    // Fix 9: AbortController with 30s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let openaiRes;
    try {
      // Fix 3: Use fetchWithRetry; Fix 9: pass signal for timeout
      openaiRes = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 1500, // Fix 4: increased from 1000
          temperature: 0.3
        }),
        signal: controller.signal
      }, 3);
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        core.setFailed('AutoPR: OpenAI request timed out after 30s.');
        return;
      }
      throw err;
    }

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      core.setFailed(`AutoPR: OpenAI API error: ${err}`);
      return;
    }

    const openaiData = await openaiRes.json();
    let body = openaiData.choices?.[0]?.message?.content || '';

    if (!body) {
      core.setFailed('AutoPR: OpenAI returned empty response.');
      return;
    }

    // Append footer
    body += '\n\n---\n*Generated by [AutoPR](https://autopr.dev)*';

    // Write PR description
    await octokit.rest.pulls.update({
      owner, repo, pull_number: pullNumber, body
    });

    core.info(`AutoPR: PR #${pullNumber} description updated successfully.`);

  } catch (err) {
    core.setFailed(`AutoPR failed: ${err.message}`);
  }
}

run();
