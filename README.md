# issue-ai-analyze

English | [中文](./README.zh.md)

[![Validate](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml/badge.svg)](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml)
[![Release](https://img.shields.io/github/v/release/mingzaily/issue-ai-analyze?display_name=tag)](https://github.com/mingzaily/issue-ai-analyze/releases)
[![Stars](https://img.shields.io/github/stars/mingzaily/issue-ai-analyze?style=social)](https://github.com/mingzaily/issue-ai-analyze/stargazers)

`issue-ai-analyze` is a GitHub Action for issue triage. It analyzes issue content with GitHub Copilot CLI by default, or with a built-in OpenAI-compatible client, normalizes the result into a small set of canonical labels, maps them to repository labels, and writes a structured analysis comment.

## What It Does

- classify issues into `bug`, `question`, `enhancement`, or `documentation`
- surface possible duplicates and `needs-info` follow-up
- map canonical labels to repository labels
- create or update a structured AI analysis comment
- run with GitHub Copilot CLI by default, or preserve an OpenAI-compatible endpoint

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
| `github-token` | Yes | Token with `issues: write` and, for the default Copilot transport, `copilot-requests: write` permission. In most workflows this is `secrets.GITHUB_TOKEN`. |
| `issue-number` | No | Issue number used for `workflow_dispatch` when the event has no Issue payload. |
| `language` | No | Output language for the bundled prompt and built-in comments. Supported values: `zh`, `en`. Default `zh`. |
| `model` | No | Optional model override. Leave empty for Copilot to choose its currently available default. A simple legacy `openai/<model>` name is normalized for either transport. |
| `prompt-file` | No | Path to a custom prompt YAML file. Defaults to the bundled `prompts/general.prompt.yml`. |
| `label-map` | No | Inline label mapping. Use one `key=value` entry per line. Use `rerun=` for rerun labels. |
| `label-map-file` | No | Path to a YAML label management file. Overrides `label-map`. |
| `openai-compatible-endpoint` | No | Custom inference endpoint. Must be used with `openai-compatible-token`. |
| `openai-compatible-token` | No | Token for the custom endpoint. |
| `openai-compatible-headers` | No | JSON or YAML object of extra headers for the OpenAI-compatible endpoint. Header names and scalar values are validated before the request. |
| `openai-compatible-response-format` | No | OpenAI-compatible response strategy: `auto`, `json_schema`, `json_object`, or `prompt` (`text` is an alias). Default `auto`. |
| `comment-marker` | No | Hidden marker used to find the latest AI analysis comment. |
| `ignore-label` | No | Label that disables analysis and label synchronization. Default `ai-ignore`; set empty to disable. |
| `label-management` | No | Label policy: `replace`, `add-only`, or `none`. Default `replace`. |
| `recent-comments-limit` | No | Number of recent comments included in the prompt. Must be an integer from `1` to `100`; default `10`. |
| `open-issues-limit` | No | Number of open issues included for duplicate detection. Must be an integer from `1` to `100`; default `50`. |

## Outputs

| Name | Description |
| --- | --- |
| `should-run` | Whether the current event triggered analysis. |
| `skip-reason` | Why analysis was skipped when `should-run` is `false`. |
| `issue-number` | Issue number selected for the run. |
| `ok` | Whether normalization succeeded. |
| `result-json` | Final normalized analysis result. |
| `labels` | JSON array of mapped labels selected by the analysis; the policy may prevent them from being applied. |
| `category` | Normalized category. |
| `disposition` | Normalized disposition. |
| `needs-info` | Whether the issue still needs more information. |
| `comment-id` | The AI comment created or updated during this run. |
| `comment-status` | Final comment state: `analysis`, `stale`, `fallback`, `newer-run`, `comment-missing`, or `publish-failed`. |
| `label-sync-status` | Label synchronization state: `applied`, `policy-none`, `conflict`, `ignored`, `stale`, `failed`, or `not-applied`. |
| `comment-strategy` | `replace_latest` or `new_comment`. |
| `transport` | `copilot` or `openai-compatible`. |
| `resolved-model` | Effective model resolved from the prompt file or action defaults. Empty means Copilot CLI chooses its default; simple legacy `openai/<model>` names are normalized when unambiguous. |
| `resolved-response-format` | Effective response format resolved from the prompt file. |
| `resolved-model-parameters` | Effective `modelParameters` object resolved from the prompt file, serialized as JSON. |
| `openai-compatible-response-format` | Effective response strategy selected for the OpenAI-compatible transport. |

## Inference Transports

The default transport is GitHub Copilot CLI through `actions/ai-inference@v3`. The bundled prompt leaves `model` empty, so the action installs the latest `@github/copilot`, passes the workflow's `GITHUB_TOKEN`, and lets Copilot choose a currently available default. Model availability can vary by Copilot entitlement; set `model` only to a model currently available to the calling organization or account. Legacy `openai/<model>` style names are converted to `<model>` only for the Copilot transport.

The calling workflow must grant the minimum permissions below:

```yaml
permissions:
  contents: read
  issues: write
  copilot-requests: write
```

The default transport requires access to GitHub Copilot; installing the CLI alone is not enough. For an organization-owned repository using `GITHUB_TOKEN`, an organization owner must enable **Allow use of Copilot CLI billed to the organization** in the organization's Copilot policies. GitHub documents this policy as separate from the Copilot licensing setup: an organization that is only hosting the repository may need the policy even when Copilot licenses are managed elsewhere. For a personally owned repository, usage is billed to the repository owner's Copilot seat, so that account must have an available Copilot entitlement. See [Using Copilot CLI in GitHub Actions with `GITHUB_TOKEN`](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions) and [About using Copilot CLI in GitHub Actions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/copilot-cli-in-github-actions).

Copilot requests consume GitHub AI credits. If the organization policy cannot be enabled, a fine-grained PAT with the `Copilot Requests` permission can be passed as `github-token`; it is billed to the PAT owner's Copilot seat and still needs `issues: write` for this action to update comments and labels. If you do not want to use GitHub Copilot, configure the explicit OpenAI-compatible transport below; that path does not require Copilot access or `copilot-requests: write`.

If the policy, entitlement, permission, authentication, or CLI installation is unavailable, the action keeps its fallback-comment behavior and exposes a diagnostic such as `copilot-cli-install-failed` or `copilot-inference-failed`; a successful workflow conclusion alone does not prove that inference succeeded.

GitHub Models is not used by the default transport. It was retired; existing OpenAI-compatible configurations remain supported through the explicit compatibility transport.

## Basic Usage

```yaml
name: AI Issue Assistant

on:
  workflow_dispatch:
    inputs:
      issue-number:
        description: Issue number to analyze
        required: true
        type: number
  issues:
    types: [opened, reopened, edited, labeled]
  issue_comment:
    types: [created, edited]

permissions:
  contents: read
  issues: write
  copilot-requests: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    concurrency:
      group: issue-ai-analyze-${{ github.repository }}-${{ github.event.issue.number || inputs.issue-number || github.run_id }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v4

      - uses: mingzaily/issue-ai-analyze@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          label-map-file: ./.github/issue-ai-label-map.yml
          language: zh
```

See [`examples/issue-analyze.yml`](./examples/issue-analyze.yml) for a complete example.

## OpenAI-Compatible Endpoint

When `openai-compatible-endpoint` and `openai-compatible-token` are both set, the action keeps the explicit OpenAI-compatible transport and does not install or call Copilot. The transport uses a small built-in HTTP client, so it can control `response_format`, forward validated `openai-compatible-headers`, and preserve the upstream HTTP error in the fallback comment. The endpoint may be a base URL such as `https://example.com/v1`; `/chat/completions` is added automatically.

The default `openai-compatible-response-format: auto` strategy is designed for providers with different levels of OpenAI compatibility:

- If the prompt declares `json_schema`, try `json_schema` first.
- If the provider returns a 400/422 error that clearly indicates an unsupported response format, retry with `json_object`, then with no `response_format` parameter.
- The final prompt-only attempt adds a JSON-only instruction (and the schema when available). The existing normalizer still parses and validates the model result.

Use `json_schema` when the endpoint is known to support it and you want a hard failure instead of negotiation. Use `json_object` or `prompt` when the provider documents only that capability. `text` is accepted as an alias for `prompt`. A model name such as `openai/gpt-4.1` is normalized to `gpt-4.1`; ambiguous names such as `openai/azure/gpt-4.1` fail with a diagnostic rather than being silently changed.

Headers can be supplied as either JSON or a simple YAML mapping. For example:

```yaml
openai-compatible-headers: |
  X-Provider: packy
  X-Trace: issue-ai-analyze
```

Invalid header names, non-scalar values, duplicate case-insensitive names, and control characters are rejected before a request is made. The token input supplies `Authorization: Bearer ...` unless a custom Authorization header is explicitly provided.

This compatibility path does not require GitHub Copilot or `copilot-requests: write`, but it still requires `issues: write` for the GitHub API operations performed by the action.

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
    openai-compatible-response-format: auto
```

The compatibility transport does not require GitHub Copilot or `copilot-requests: write`, but it still requires `issues: write` for GitHub API operations. If the upstream returns 400, 401, 404, or another request error, the final fallback comment includes a sanitized `openai-compatible-http-*` diagnostic instead of only `missing-ai-response-file`.

## Custom Prompt

```yaml
- uses: mingzaily/issue-ai-analyze@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
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

Rerun labels must be different from every mapped AI-managed label and from `ignore-label`. The configured `ignore-label` must also be different from every mapped AI-managed label. For example, `rerun=ai-rerun` is valid, while `rerun=type/bug` is rejected when `bug=type/bug` is configured.

The action records the labels it has added in a hidden metadata marker inside its AI comment. In `replace` mode, it removes only labels recorded as AI-owned; labels that predate the metadata remain untouched. During analysis, if a maintainer changes any currently managed label, the action reports `label-sync-status: conflict` and does not overwrite the manual change. On the first run after upgrading, existing labels are treated conservatively and are not claimed retroactively.

Before changing labels, the action also records a hidden pending intent. After GitHub confirms the label update, the intent is marked as confirmed so a later run can recover ownership if finalization is interrupted. Tentative intents are never used to claim labels after a manual conflict.

By default, the action replaces only its managed labels. Use `label-management: add-only` to preserve existing managed labels, or `label-management: none` to publish analysis without changing labels. Add the `ai-ignore` label (or configure another `ignore-label`) when a maintainer wants to keep AI away from an issue.

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
- `workflow_dispatch` can analyze a selected open Issue by supplying `issue-number`.
- Closed issues and pull-request conversations are skipped.
- If the issue author replies while `needs-info` is present, the action creates a new AI comment.
- Configured rerun labels from label management update the latest AI comment.
- The action manages only the mapped labels for the canonical labels above.
- A single finalization step always attempts to replace the pending comment with an analysis, stale-result, cancellation/fallback, or newer-run status.
- Before publishing, the action rechecks the latest non-AI discussion; a new or edited user comment invalidates the in-flight result.
- The action does not close issues.

Custom prompt files must preserve the bundled JSON contract. The field `needsInfo` must be a boolean, `confidence` must be a number from `0` to `1`, and all required fields must be present; malformed model output fails closed and produces a fallback comment.

For stricter supply-chain control, pin `mingzaily/issue-ai-analyze` to a full release commit SHA instead of the convenience tag `@v1`. The bundled third-party actions are pinned to full SHAs.
