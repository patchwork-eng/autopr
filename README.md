# AutoPR

**AutoPR automatically writes your pull request descriptions using AI — drop it in your workflow and never write a PR body again.**

---

## Quick Start

```yaml
name: AutoPR
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  pull-requests: write   # ← required

jobs:
  autopr:
    runs-on: ubuntu-latest
    steps:
      - uses: patchwork-eng/autopr@v1
        with:
          openai_key: ${{ secrets.OPENAI_KEY }}
          # license_key: ${{ secrets.AUTOPR_LICENSE_KEY }}  # Required for private repos
```

> **⚠️ Important:** The `pull-requests: write` permission is required. Without it, the Action cannot update your PR description and will fail.

---

## How It Works

When a pull request is opened or updated, AutoPR:

1. Fetches the diff
2. Sends it to OpenAI with a structured prompt
3. Writes the generated description back to the PR

The generated description includes:
- **Summary** — what changed and why
- **Changes** — grouped by breaking changes, features, fixes, refactors, chores
- **Testing notes** — what reviewers should verify
- **Affected areas** — which modules were touched

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `openai_key` | ✅ | — | Your OpenAI API key |
| `license_key` | For private repos | `''` | AutoPR license key |
| `model` | No | `gpt-4o-mini` | OpenAI model to use |
| `max_diff_lines` | No | `500` | Max diff lines sent to OpenAI |
| `skip_if_body_set` | No | `true` | Skip if PR already has a description (>30 chars) |
| `template` | No | `''` | Path to a PR template file in your repo |

---

## Pricing

| Plan | Price | For |
|---|---|---|
| **Free** | $0 | Public repos, unlimited |
| **Indie** | $9/mo | Private repos, 1 user |
| **Teams** | $19/mo | Private repos, unlimited team members |

Get a license key at **[autopr.dev](https://autopr.dev)**.

---

## Trust & Security (BYOK)

AutoPR uses **Bring Your Own Key (BYOK)**. Your OpenAI API key is passed directly from your GitHub Secrets to the OpenAI API — it never touches our servers.

What we do see:
- License validation requests (repo name + license key) for private repos
- Nothing else

Your code and diffs go directly from GitHub to OpenAI using your own key.

---

## Template Support

You can provide a custom PR template to guide the output format:

```yaml
- uses: patchwork-eng/autopr@v1
  with:
    openai_key: ${{ secrets.OPENAI_KEY }}
    template: .github/PULL_REQUEST_TEMPLATE.md
```

AutoPR will use your template as a structural guide while still generating the content from the diff.

---

## Sister Product

Need changelogs too? Check out **[Difflog](https://difflog.io)** — the same team, same philosophy. Drop it in your workflow and get auto-generated changelogs on every merge.

---

## License

MIT
