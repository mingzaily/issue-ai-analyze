# issue-ai-analyze

[English](./README.md) | 中文

[![Validate](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml/badge.svg)](https://github.com/mingzaily/issue-ai-analyze/actions/workflows/validate.yml)
[![Release](https://img.shields.io/github/v/release/mingzaily/issue-ai-analyze?display_name=tag)](https://github.com/mingzaily/issue-ai-analyze/releases)
[![Stars](https://img.shields.io/github/stars/mingzaily/issue-ai-analyze?style=social)](https://github.com/mingzaily/issue-ai-analyze/stargazers)

`issue-ai-analyze` 是一个用于 issue triage 的 GitHub Action。它通过 `actions/ai-inference` 分析 issue 内容，将结果归一化为一组较小的 canonical labels，映射到仓库标签，并写入结构化分析评论。

## 主要行为

- 将 issue 归类为 `bug`、`question`、`enhancement` 或 `documentation`
- 提示可能的重复 issue，并处理 `needs-info` 跟进
- 将 canonical labels 映射到仓库自己的标签
- 创建或更新结构化 AI 分析评论
- 默认使用 GitHub Copilot CLI，也保留 OpenAI-compatible 接口

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
| `github-token` | 是 | 需要有 `issues: write`；默认 Copilot 通道还需要 `copilot-requests: write` 的 GitHub Token。大多数场景直接传 `secrets.GITHUB_TOKEN` 即可。 |
| `issue-number` | 否 | `workflow_dispatch` 没有 Issue payload 时使用的 Issue 编号。 |
| `language` | 否 | 内置 prompt 和内置评论文案的输出语言。支持值：`zh`、`en`，默认 `zh`。 |
| `model` | 否 | 推理模型覆盖值。 |
| `prompt-file` | 否 | 自定义 prompt YAML 文件路径。默认使用内置的 `prompts/general.prompt.yml`。 |
| `label-map` | 否 | 内联标签映射，按行写 `key=value`。重跑标签用 `rerun=`。 |
| `label-map-file` | 否 | YAML 标签管理配置文件路径，优先级高于 `label-map`。 |
| `openai-compatible-endpoint` | 否 | 自定义推理接口地址，必须和 `openai-compatible-token` 一起使用。 |
| `openai-compatible-token` | 否 | 自定义接口 Token。 |
| `openai-compatible-headers` | 否 | 透传给 OpenAI-compatible 推理 action 的额外请求头。 |
| `comment-marker` | 否 | 用于定位最新 AI 分析评论的隐藏标记。 |
| `ignore-label` | 否 | 禁用分析和标签同步的标签，默认 `ai-ignore`；设为空可禁用。 |
| `label-management` | 否 | 标签策略：`replace`、`add-only` 或 `none`，默认 `replace`。 |
| `recent-comments-limit` | 否 | 传给 prompt 的最新评论数量，必须是 `1` 到 `100` 的整数，默认 `10`。 |
| `open-issues-limit` | 否 | 用于重复判断的 open issue 数量，必须是 `1` 到 `100` 的整数，默认 `50`。 |

## 输出参数

| 名称 | 说明 |
| --- | --- |
| `should-run` | 当前事件是否触发分析。 |
| `skip-reason` | `should-run` 为 `false` 时的跳过原因。 |
| `issue-number` | 本次运行选中的 Issue 编号。 |
| `ok` | 规范化是否成功。 |
| `result-json` | 最终规范化后的分析结果 JSON。 |
| `labels` | 分析选中的映射后标签数组 JSON；具体是否应用由标签策略决定。 |
| `category` | 规范化后的分类。 |
| `disposition` | 规范化后的处置结果。 |
| `needs-info` | 当前是否仍需补充信息。 |
| `comment-id` | 本次创建或更新的 AI 评论 ID。 |
| `comment-status` | 最终评论状态：`analysis`、`stale`、`fallback`、`newer-run`、`comment-missing` 或 `publish-failed`。 |
| `label-sync-status` | 标签同步状态：`applied`、`policy-none`、`conflict`、`ignored`、`stale`、`failed` 或 `not-applied`。 |
| `comment-strategy` | `replace_latest` 或 `new_comment`。 |
| `transport` | `copilot` 或 `openai-compatible`。 |
| `resolved-model` | 从 prompt 文件或 action 默认值解析得到的最终模型；Copilot 通道会把旧的 `openai/<model>` 名称规范化。 |
| `resolved-response-format` | 从 prompt 文件解析得到的最终响应格式。 |
| `resolved-model-parameters` | 从 prompt 文件解析得到的最终 `modelParameters` 对象，JSON 字符串形式。 |

## 推理通道

默认通道是通过 `actions/ai-inference@v3` 调用 GitHub Copilot CLI。Action 会安装最新版 `@github/copilot`，把 workflow 的 `GITHUB_TOKEN` 交给 CLI，并使用配置的 Copilot 模型。`model: gpt-4.1` 是有效覆盖值；如果最终模型为空，则允许 Copilot CLI 自动选择默认模型。只有 Copilot 通道会把旧的 `openai/gpt-4.1` 形式转换为 `gpt-4.1`。

调用方需要配置以下最小权限：

```yaml
permissions:
  contents: read
  issues: write
  copilot-requests: write
```

组织仓库还必须启用 **Allow use of Copilot CLI billed to the organization**。Copilot 请求可能消耗组织或仓库所有者的 GitHub Copilot AI credits，请结合组织策略和 spending controls 谨慎启用。如果策略、权限、鉴权或 CLI 安装不可用，Action 仍会发布 fallback 评论，并给出 `copilot-cli-install-failed` 或 `copilot-inference-failed` 等诊断；workflow 显示 Success 不能单独证明推理成功。

默认通道不再使用 GitHub Models。GitHub Models 已退役；已有的 OpenAI-compatible 配置会继续通过显式兼容通道运行。

## 基础用法

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
          model: gpt-4.1
          language: zh
```

完整示例见 [`examples/issue-analyze.yml`](./examples/issue-analyze.yml)。

## OpenAI-Compatible 接口

同时设置 `openai-compatible-endpoint` 和 `openai-compatible-token` 时，Action 会继续使用显式的 OpenAI-compatible 通道，并透传 `openai-compatible-headers`，不会调用 Copilot。这保证已有自定义接口配置不因默认通道迁移而失效。

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
    model: gpt-4.1
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

如果更喜欢结构化配置，可以用 YAML 格式的 `label-map-file`。

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

`label-map` 和 `label-map-file` 只负责重命名这几个内置语义标签，不会新增新的 canonical category，也不支持把一个语义标签直接映射成多个仓库标签。

重跑标签不能与任何映射后的 AI 托管标签或 `ignore-label` 相同，`ignore-label` 也不能与映射后的 AI 托管标签相同。例如配置了 `bug=type/bug` 时，`rerun=ai-rerun` 有效，但 `rerun=type/bug` 会被拒绝。

Action 会在自己的 AI 评论中用隐藏元数据记录由 AI 添加的标签。`replace` 模式只会删除这些已记录为 AI 所有的标签；升级前已经存在的标签不会被追溯认领。分析期间如果维护者修改了当前托管标签中的任意一个，Action 会返回 `label-sync-status: conflict`，不会覆盖这次人工调整。

在修改标签前，Action 还会记录一份隐藏的待同步意图。GitHub 确认标签更新后，这份意图才会标记为已确认；如果 finalize 被中断，后续运行可以据此恢复标签归属。未确认的意图不会在发生人工冲突后被用来认领标签。

默认情况下，Action 只替换自己托管的标签。可以使用 `label-management: add-only` 保留已有托管标签，或使用 `label-management: none` 只发布分析评论、不修改标签。维护者希望禁止 AI 处理某个 Issue 时，可以添加 `ai-ignore` 标签，也可以通过 `ignore-label` 配置其他标签名。

## 自定义标签扩展

当前内置的语义标签有：

- `bug`
- `question`
- `enhancement`
- `documentation`
- `duplicate`
- `needs-info`

这一组标签对应的是一层较小、可复用的 triage 语义。对很多小型仓库来说，这一层本身已经够用。

如果你的仓库还会使用 `area/*`、`priority/*`、`status/*` 这一类标签，通常更适合让 `issue-ai-analyze` 只负责上面的 canonical labels，再在 workflow 里基于 action outputs 派生仓库自己的标签。

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

这样做的结果是，action 本身的行为会更稳定，而需要额外标签体系的仓库也可以在单独的 workflow 步骤里继续扩展。

## 行为说明

- `issues.opened`、`issues.reopened`、`issues.edited` 以及配置的重跑标签会触发分析。
- `workflow_dispatch` 可以通过填写 `issue-number` 手动分析一个 open Issue。
- 已关闭的 issue 和 pull request 对话会被跳过。
- 当 issue 作者在 `needs-info` 状态下回复时，会新增一条 AI 评论。
- 标签管理配置中的重跑标签会更新最新一条 AI 评论。
- action 只管理上面这些语义标签映射后的目标标签。
- 最后的 finalize 步骤会在取消、失败、内容过期或并发覆盖时，尽量把“分析中”评论更新为对应状态。
- 发布前会重新校验最新的非 AI 讨论；分析期间新增或修改作者/维护者评论时，本次结果会失效，不再发布旧上下文的结论。
- action 不负责自动关闭 issue。

自定义 prompt 必须保持内置 JSON 契约：`needsInfo` 必须是布尔值，`confidence` 必须是 `0` 到 `1` 的数字，并且所有必填字段都要存在。模型输出格式异常时会安全失败，并更新为 fallback 评论。

如果对供应链安全要求更高，建议把 `mingzaily/issue-ai-analyze` 从方便使用的 `@v1` 固定到完整 release commit SHA。Action 内部依赖的第三方 Actions 已固定到完整 SHA。
