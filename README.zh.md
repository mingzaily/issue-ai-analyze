# issue-ai-analyze

[GitHub](https://github.com/mingzaily/issue-ai-analyze) ｜ [English README](./README.md)

[![Validate](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml/badge.svg)](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml)
[![Release](https://img.shields.io/github/v/release/mingzaily/issue-ai-analyze?display_name=tag)](https://github.com/mingzaily/issue-ai-analyze/releases)
[![Stars](https://img.shields.io/github/stars/mingzaily/issue-ai-analyze?style=social)](https://github.com/mingzaily/issue-ai-analyze/stargazers)

`issue-ai-analyze` 是一个用于 GitHub Issue 分析的 Action。

它可以：

- 用 `actions/ai-inference` 分析 issue 内容
- 将模型输出规范化为内部语义标签
- 将内部语义标签映射到仓库标签
- 发布和更新 AI 分析评论
- 使用 GitHub Models 或 OpenAI-compatible 接口

## 内部语义标签

这个 action 内部使用以下语义标签：

- `bug`
- `question`
- `enhancement`
- `documentation`
- `duplicate`
- `needs-info`

如果仓库使用不同的标签名，可以通过 `label-map` 或 `label-map-file` 做映射。

## 输入参数

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `github-token` | 是 | 需要有 `issues: write` 权限的 GitHub Token。大多数场景直接传 `secrets.GITHUB_TOKEN` 即可。 |
| `language` | 否 | 内置 prompt 和内置评论文案的输出语言。支持值：`zh`、`en`，默认 `zh`。 |
| `model` | 否 | 推理模型覆盖值。 |
| `prompt-file` | 否 | 自定义 prompt YAML 文件路径。默认使用内置的 `prompts/general.prompt.yml`。 |
| `label-map` | 否 | 内联标签映射，按行写 `key=value`。重跑标签用 `rerun=`。 |
| `label-map-file` | 否 | YAML 或 TOML 标签管理配置文件路径，优先级高于 `label-map`。 |
| `openai-compatible-endpoint` | 否 | 自定义推理接口地址，必须和 `openai-compatible-token` 一起使用。 |
| `openai-compatible-token` | 否 | 自定义接口 Token。 |
| `openai-compatible-headers` | 否 | 透传给 `actions/ai-inference` 的额外请求头。 |
| `comment-marker` | 否 | 用于定位最新 AI 分析评论的隐藏标记。 |
| `recent-comments-limit` | 否 | 传给 prompt 的最新评论数量，默认 `10`。 |
| `open-issues-limit` | 否 | 用于重复判断的 open issue 数量，默认 `50`。 |

## 输出参数

| 名称 | 说明 |
| --- | --- |
| `should-run` | 当前事件是否触发分析。 |
| `ok` | 规范化是否成功。 |
| `result-json` | 最终规范化后的分析结果 JSON。 |
| `labels` | 实际应用到 issue 的标签数组 JSON。 |
| `category` | 规范化后的分类。 |
| `disposition` | 规范化后的处置结果。 |
| `needs-info` | 当前是否仍需补充信息。 |
| `comment-id` | 本次创建或更新的 AI 评论 ID。 |
| `comment-strategy` | `replace_latest` 或 `new_comment`。 |
| `transport` | `github-models` 或 `openai-compatible`。 |

## 基础用法

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

完整示例见 [`examples/issue-analyze.yml`](./examples/issue-analyze.yml)。

## OpenAI-Compatible 接口

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

## 自定义 Prompt

```yaml
- uses: mingzaily/issue-ai-analyze@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    model: openai/gpt-4.1
    language: en
    prompt-file: ./.github/prompts/my-custom-issue-analysis.prompt.yml
```

## 标签管理

支持的键有 `bug`、`question`、`enhancement`、`documentation`、`duplicate`、`needs-info` 和 `rerun`。

小型映射可以直接写在 `label-map`：

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

如果更喜欢结构化配置，可以用 `label-map-file`。

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

同一份配置也可以写成 TOML：

```toml
bug = "type/bug"
question = "type/question"
enhancement = "type/feature"
documentation = "type/docs"
duplicate = "duplicate"
needs-info = "needs-info"
rerun = ["ai-rerun", "ai-recheck"]
```

## 行为说明

- `issues.opened`、`issues.reopened`、`issues.edited` 以及配置的重跑标签会触发分析。
- 当 issue 作者在 `needs-info` 状态下回复时，会新增一条 AI 评论。
- 标签管理配置中的重跑标签会更新最新一条 AI 评论。
- action 只管理上面这些语义标签映射后的目标标签。
- action 不负责自动关闭 issue。
