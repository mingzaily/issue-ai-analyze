# Copilot instructions for issue-ai-analyze

This repository publishes a composite GitHub Action. Treat changes to inputs, outputs, prompt variables, label semantics, and comment behavior as public API changes.

When writing or reviewing changes in this repository:

- Keep the configuration surface small and explicit.
- `label-map` is the simple inline form. `label-map-file` is the structured YAML form.
- The bundled prompt lives at `prompts/general.prompt.yml`.
- If user-facing behavior changes, update `action.yml`, `README.md`, `README.zh.md`, `examples/`, and `.github/workflows/validate.yml` together.
- `README.md` must stay English. `README.zh.md` must stay Simplified Chinese. Keep both files aligned in meaning and neutral in tone.
- Prefer deterministic, dependency-light logic inside the composite action.
- Be careful with rerun triggers, label removal, comment replacement, secrets, and GitHub permission scope.
- Do not add marketing language, project comparisons, or speculative roadmap notes to the README files.

When performing pull request reviews:

- Always respond in Simplified Chinese.
- Keep findings concise, actionable, and technically specific.
- Prioritize correctness, compatibility, failure handling, and missing validation.
- If no major issue is found, give a short Chinese summary plus residual risks instead of forcing problems.
