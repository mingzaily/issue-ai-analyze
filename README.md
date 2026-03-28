# issue-ai-analyze

English | [中文](./README.zh.md)

[![Validate](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml/badge.svg)](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml)
[![Release](https://img.shields.io/github/v/release/mingzaily/issue-ai-analyze?display_name=tag)](https://github.com/mingzaily/issue-ai-analyze/releases)
[![Stars](https://img.shields.io/github/stars/mingzaily/issue-ai-analyze?style=social)](https://github.com/mingzaily/issue-ai-analyze/stargazers)

`issue-ai-analyze` is a GitHub Action for issue triage. It analyzes issue content with `actions/ai-inference`, normalizes the result into a small set of canonical labels, maps them to repository labels, and writes a structured analysis comment.

## What It Does

- classify issues into `bug`, `question`, `enhancement`, or `documentation`
- surface possible duplicates and `needs-info` follow-up
- map canonical labels to repository labels
- create or update a structured AI analysis comment
- run with GitHub Models or an OpenAI-compatible endpoint

## Canonical Labels

The action uses these canonical labels internally:

- `bug`
- `question`
- `enhancement`
- `documentation`
- `duplicate`
- `needs-info`

Use `label-map` or `label-map-file` if your repository uses different label names.

## Inputs

| Name | Required | Description |
| --- | --- | --- |
| `github-token` | Yes | Token with `issues: write` permission. In most workflows this is `secrets.GITHUB_TOKEN`. |
| `language` | No | Output language for the bundled prompt and built-in comments. Supported values: `zh`, `en`. Default `zh`. |
| `model` | No | Model override for inference. |
| `prompt-file` | No | Path to a custom prompt YAML file. Defaults to the bundled `prompts/general.prompt.yml`. |
| `label-map` | No | Inline label mapping. Use one `key=value` entry per line. Use `rerun=` for rerun labels. |
| `label-map-file` | No | Path to a YAML label management file. Overrides `label-map`. |
| `openai-compatible-endpoint` | No | Custom inference endpoint. Must be used with `openai-compatible-token`. |
| `openai-compatible-token` | No | Token for the custom endpoint. |
| `openai-compatible-headers` | No | Extra headers forwarded to `actions/ai-inference`. |
| `comment-marker` | No | Hidden marker used to find the latest AI analysis comment. |
| `recent-comments-limit` | No | Number of recent comments included in the prompt. Default `10`. |
| `open-issues-limit` | No | Number of open issues included for duplicate detection. Default `50`. |

## Outputs

| Name | Description |
| --- | --- |
| `should-run` | Whether the current event triggered analysis. |
| `ok` | Whether normalization succeeded. |
| `result-json` | Final normalized analysis result. |
| `labels` | JSON array of mapped labels applied to the issue. |
| `category` | Normalized category. |
| `disposition` | Normalized disposition. |
| `needs-info` | Whether the issue still needs more information. |
| `comment-id` | The AI comment created or updated during this run. |
| `comment-strategy` | `replace_latest` or `new_comment`. |
| `transport` | `github-models` or `openai-compatible`. |
| `resolved-model` | Effective model resolved from the prompt file or action defaults. |
| `resolved-response-format` | Effective response format resolved from the prompt file. |
| `resolved-model-parameters` | Effective `modelParameters` object resolved from the prompt file, serialized as JSON. |

## Basic Usage

```yaml
name: AI Issue Assistant

on:
  issues:
    types: [opened, reopened, edited, labeled]
  issue_comment:
    types: [created]

permissions:
  contents: read
  issues: write
  models: read

jobs:
  analyze:
    runs-on: ubuntu-latest
    concurrency:
      group: issue-ai-analyze-${{ github.repository }}-${{ github.event.issue.number }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v4

      - uses: mingzaily/issue-ai-analyze@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          label-map-file: ./.github/issue-ai-label-map.yml
          model: openai/gpt-4.1
          language: zh
```

See [`examples/issue-analyze.yml`](./examples/issue-analyze.yml) for a complete example.

## OpenAI-Compatible Endpoint

```yaml
- uses: mingzaily/issue-ai-analyze@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    label-map-file: ./.github/issue-ai-label-map.yml
    model: deepseek-chat
    language: en
    openai-compatible-endpoint: ${{ vars.ISSUE_OPENAI_COMPAT_ENDPOINT }}
    openai-compatible-token: ${{ secrets.ISSUE_OPENAI_COMPAT_TOKEN }}
    openai-compatible-headers: ${{ vars.ISSUE_OPENAI_COMPAT_HEADERS }}
```

## Custom Prompt

```yaml
- uses: mingzaily/issue-ai-analyze@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    model: openai/gpt-4.1
    language: en
    prompt-file: ./.github/prompts/my-custom-issue-analysis.prompt.yml
```

## Label Management

Supported keys are `bug`, `question`, `enhancement`, `documentation`, `duplicate`, `needs-info`, and `rerun`.

Use `label-map` for a small inline mapping:

```yaml
with:
  label-map: |
    bug=type/bug
    question=type/question
    enhancement=type/feature
    documentation=type/docs
    duplicate=duplicate
    needs-info=needs-info
    rerun=ai-rerun,ai-recheck
```

Use `label-map-file` when you prefer a structured YAML file.

```yaml
bug: type/bug
question: type/question
enhancement: type/feature
documentation: type/docs
duplicate: duplicate
needs-info: needs-info
rerun:
  - ai-rerun
  - ai-recheck
```

`label-map` and `label-map-file` rename the built-in canonical labels only. They do not add new canonical categories and do not map one canonical label to multiple repository labels.

## Custom Label Extensions

The built-in canonical labels are:

- `bug`
- `question`
- `enhancement`
- `documentation`
- `duplicate`
- `needs-info`

This set is meant to cover a small, reusable triage layer. For many small repositories, it is enough on its own.

If your repository also uses labels such as `area/*`, `priority/*`, or `status/*`, it is usually better to keep `issue-ai-analyze` focused on the canonical labels above and derive additional repository-specific labels in your workflow from the action outputs.

```yaml
- name: Analyze issue with AI
  id: analyze
  uses: mingzaily/issue-ai-analyze@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    label-map-file: ./.github/issue-ai-label-map.yml

- name: Add repository-specific labels
  if: ${{ steps.analyze.outputs.ok == 'true' }}
  uses: actions/github-script@v7
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    script: |
      const labels = [];

      if ("${{ steps.analyze.outputs.category }}" === "bug") {
        labels.push("triaged");
      }

      if ("${{ steps.analyze.outputs.needs-info }}" === "true") {
        labels.push("status/awaiting-author");
      }

      if ("${{ steps.analyze.outputs.disposition }}" === "duplicate") {
        labels.push("status/duplicate");
      }

      if (labels.length > 0) {
        await github.rest.issues.addLabels({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: context.payload.issue.number,
          labels
        });
      }
```

This approach keeps the action behavior predictable while still allowing larger repositories to add their own label conventions in a separate workflow step.

## Behavior

- `issues.opened`, `issues.reopened`, `issues.edited`, and configured rerun labels trigger analysis.
- If the issue author replies while `needs-info` is present, the action creates a new AI comment.
- Configured rerun labels from label management update the latest AI comment.
- The action manages only the mapped labels for the canonical labels above.
- The action does not close issues.
