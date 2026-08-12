require 'json'
require 'yaml'

normalize_map_string = lambda do |raw|
  value = raw.to_s.strip
  if (value.start_with?('"') && value.end_with?('"')) || (value.start_with?("'") && value.end_with?("'"))
    value = value[1...-1]
  end
  value.strip
end

parse_label_map_inline = lambda do |raw|
  parsed = {}
  raw.to_s.gsub(';', "\n").each_line.with_index(1) do |line, line_number|
    stripped = line.sub(/\s+#.*\z/, '').strip
    next if stripped.empty?

    match = stripped.match(/\A([A-Za-z0-9._-]+)\s*=\s*(.+)\z/)
    unless match
      abort("Invalid label-map entry at line #{line_number}. Expected key=value, got: #{line.strip}")
    end

    parsed[match[1]] = normalize_map_string.call(match[2])
  end
  parsed
end

parse_label_map_file = lambda do |path|
  content = File.read(path)
  ext = File.extname(path).downcase

  if ext != '.yml' && ext != '.yaml'
    abort("label-map-file must be a YAML file: #{path}")
  end

  YAML.safe_load(content, aliases: false) || {}
end

default_prompt = File.join(ENV.fetch('ACTION_PATH'), 'prompts', 'general.prompt.yml')
prompt_source = ENV['INPUT_PROMPT_FILE'].to_s.strip
prompt_source = default_prompt if prompt_source.empty?
unless File.exist?(prompt_source)
  abort("Prompt file not found: #{prompt_source}")
end

raw_language = ENV['INPUT_LANGUAGE'].to_s.strip.downcase
normalized_language =
  case raw_language
  when '', 'zh'
    'zh'
  when 'en'
    'en'
  else
    abort("Unsupported language: #{raw_language}. Supported values are: zh, en")
  end

endpoint = ENV['INPUT_OPENAI_COMPAT_ENDPOINT'].to_s.strip
token = ENV['INPUT_OPENAI_COMPAT_TOKEN'].to_s.strip
if endpoint.empty? ^ token.empty?
  abort('openai-compatible-endpoint and openai-compatible-token must be set together')
end
transport = endpoint.empty? ? 'copilot' : 'openai-compatible'

response_format_aliases = {
  'auto' => 'auto',
  'json_schema' => 'json_schema',
  'json-schema' => 'json_schema',
  'json_object' => 'json_object',
  'json-object' => 'json_object',
  'prompt' => 'prompt',
  'prompt-only' => 'prompt',
  'text' => 'prompt'
}
requested_response_format = ENV['INPUT_OPENAI_COMPAT_RESPONSE_FORMAT'].to_s.strip.downcase
openai_compatible_response_format =
  if requested_response_format.empty?
    'auto'
  elsif response_format_aliases.key?(requested_response_format)
    response_format_aliases.fetch(requested_response_format)
  else
    abort("Invalid openai-compatible-response-format: #{requested_response_format.inspect}. Supported values: auto, json_schema, json_object, prompt")
  end

parse_compatible_headers = lambda do |raw|
  value = raw.to_s.strip
  next {} if value.empty?

  parsed = begin
    JSON.parse(value)
  rescue JSON::ParserError
    begin
      YAML.safe_load(value, aliases: false)
    rescue Psych::Exception => error
      abort("Invalid openai-compatible-headers: #{error.message.lines.first.to_s.strip}")
    end
  end

  unless parsed.is_a?(Hash)
    abort('Invalid openai-compatible-headers: expected a JSON or YAML object')
  end

  header_name_pattern = /\A[A-Za-z0-9!#$%&'*+\-.^_`|~]+\z/
  normalized = {}
  parsed.each do |raw_name, raw_header_value|
    unless raw_name.is_a?(String) && raw_name.match?(header_name_pattern)
      abort("Invalid openai-compatible-headers: invalid header name #{raw_name.inspect}")
    end
    unless [String, Numeric, TrueClass, FalseClass].any? { |type| raw_header_value.is_a?(type) }
      abort("Invalid openai-compatible-headers: value for #{raw_name.inspect} must be a scalar")
    end

    header_value = raw_header_value.to_s
    if header_value.match?(/[\r\n\u0000]/)
      abort("Invalid openai-compatible-headers: value for #{raw_name.inspect} contains control characters")
    end

    normalized_name = raw_name.strip
    if normalized.keys.any? { |name| name.casecmp?(normalized_name) }
      abort("Invalid openai-compatible-headers: duplicate header name #{raw_name.inspect}")
    end
    normalized[normalized_name] = header_value
  end
  normalized
end

openai_compatible_headers = parse_compatible_headers.call(ENV['INPUT_OPENAI_COMPAT_HEADERS'])

prompt = YAML.load_file(prompt_source)
unless prompt.is_a?(Hash)
  abort("Prompt file must be a YAML mapping: #{prompt_source}")
end

language_profile =
  if normalized_language == 'zh'
    {
      'code' => 'zh',
      'prompt_language_name' => 'Chinese',
      'comment_none_label' => '（无）',
      'pending_title' => '## 🤖 AI 分析进行中',
      'pending_body' => '正在分析该 Issue 并生成总结与标签建议，请稍候…',
      'pending_preserve' => '检测到提问者补充了信息，本次会新增一条 AI 分析评论，保留之前的分析记录。',
      'pending_replace' => '本次分析结果会直接更新最新一条 AI 分析评论。',
      'analysis_title' => '## 🤖 AI 初步分析结果',
      'summary_label' => '问题概述',
      'suggested_labels_label' => '建议标签',
      'suggested_title_label' => '建议标题',
      'info_assessment_label' => '信息完整度',
      'confidence_label' => '置信度',
      'duplicate_of_label' => '可能重复于',
      'suggestions_heading_needed' => '### 建议补充',
      'suggestions_heading_optional' => '### 可选补充',
      'sync_note' => '本次结果已同步到当前 Issue 标签。开发人员仍可按实际情况直接调整。',
      'sync_note_add_only' => '本次建议标签已补充到 Issue；已有标签保持不变。',
      'sync_note_none' => '以上是 AI 建议标签，本次没有修改 Issue 标签。',
      'sync_note_failed' => '本次分析已完成，但标签同步没有完全成功；请检查 workflow 日志并人工确认标签。',
      'sync_note_conflict' => '分析期间检测到维护者修改了 AI 管理的标签；本次没有覆盖这次人工调整。',
      'sync_note_not_applied' => '本次分析已完成，但标签同步没有结束；请人工确认当前标签。',
      'rerun_intro' => '如后续补充了信息：',
      'rerun_needs_info' => '- 提问者在 `needs-info` 状态下直接回复，我会自动重新分析。',
      'rerun_manual_template' => '- 开发人员可通过添加标签 {{rerun_labels}} 手动重跑。',
      'fallback_title' => '## ⚠️ AI 初步分析暂时失败',
      'fallback_body' => '本次自动分析未成功完成，可能是模型调用失败、返回格式异常或网络波动导致。',
      'diagnostic_label' => '诊断信息',
      'fallback_retry_template' => '你可以稍后编辑 Issue，或添加标签 {{rerun_labels}} 再试一次。',
      'fallback_manual' => '开发人员也可以直接手动打标签，不影响正常处理。',
      'stale_title' => '## ⚠️ AI 分析未同步',
      'stale_body' => '分析期间 Issue 发生了变化，或已经被标记为跳过 AI；本次结果没有修改标签。',
      'stale_body_changed' => '分析期间 Issue 标题或正文发生了变化，本次结果没有应用。',
      'stale_body_discussion' => '分析期间 Issue 新增或修改了评论，本次结果没有应用。',
      'stale_body_ignore' => '分析期间 Issue 被添加了跳过 AI 的标签，本次结果没有应用。',
      'stale_body_closed' => '分析期间 Issue 已关闭，本次结果没有应用。',
      'stale_body_verification_failed' => '无法确认 Issue 的最新状态（可能是 GitHub API 临时失败），本次结果没有应用；请稍后重试。',
      'normalize_summary_fallback' => '已完成自动分析，请维护者结合上下文继续判断。',
      'normalize_info_fallback' => '当前信息基本足够进行初步分析。',
      'normalize_duplicate_info' => '当前信息已足够判断这是一个重复问题，无需额外补充。'
    }
  else
    {
      'code' => 'en',
      'prompt_language_name' => 'English',
      'comment_none_label' => '(none)',
      'pending_title' => '## 🤖 AI Analysis In Progress',
      'pending_body' => 'Analyzing this issue and preparing a summary plus label suggestions. Please wait…',
      'pending_preserve' => 'The issue author added more information, so this run will create a new AI comment and keep previous analysis history.',
      'pending_replace' => 'This run will update the latest AI analysis comment in place.',
      'analysis_title' => '## 🤖 AI Initial Analysis',
      'summary_label' => 'Summary',
      'suggested_labels_label' => 'Suggested labels',
      'suggested_title_label' => 'Suggested title',
      'info_assessment_label' => 'Information assessment',
      'confidence_label' => 'Confidence',
      'duplicate_of_label' => 'Possible duplicate of',
      'suggestions_heading_needed' => '### Suggested follow-up',
      'suggestions_heading_optional' => '### Optional follow-up',
      'sync_note' => 'The suggested labels above have already been synced to this issue. Developers can still adjust them manually.',
      'sync_note_add_only' => 'Suggested labels were added where missing; existing labels were preserved.',
      'sync_note_none' => 'These are suggested labels only; no issue labels were changed.',
      'sync_note_failed' => 'Analysis completed, but label synchronization did not fully succeed. Please review the workflow log and labels manually.',
      'sync_note_conflict' => 'A maintainer changed an AI-managed label during analysis, so this run did not overwrite that manual change.',
      'sync_note_not_applied' => 'Analysis completed, but label synchronization did not finish. Please review the labels manually.',
      'rerun_intro' => 'If more information is added later:',
      'rerun_needs_info' => '- When the issue author replies while `needs-info` is present, I will rerun automatically.',
      'rerun_manual_template' => '- Developers can add label {{rerun_labels}} to rerun manually.',
      'fallback_title' => '## ⚠️ AI Analysis Failed',
      'fallback_body' => 'This automatic analysis did not complete successfully. The cause may be model access failure, invalid output format, or a temporary network problem.',
      'diagnostic_label' => 'Diagnostic',
      'fallback_retry_template' => 'You can edit the issue later, or add label {{rerun_labels}} to try again.',
      'fallback_manual' => 'Developers can also apply labels manually without blocking normal issue handling.',
      'stale_title' => '## ⚠️ AI Analysis Not Applied',
      'stale_body' => 'The issue changed during analysis or was marked to skip AI. This result was not applied.',
      'stale_body_changed' => 'The issue title or body changed during analysis, so this result was not applied.',
      'stale_body_discussion' => 'A discussion comment was added or edited during analysis, so this result was not applied.',
      'stale_body_ignore' => 'The issue received the configured ignore label during analysis, so this result was not applied.',
      'stale_body_closed' => 'The issue was closed during analysis, so this result was not applied.',
      'stale_body_verification_failed' => 'The latest issue state could not be verified, possibly because of a temporary GitHub API failure. This result was not applied; please retry later.',
      'normalize_summary_fallback' => 'Automatic analysis completed, but maintainers should still review the context before making a final decision.',
      'normalize_info_fallback' => 'The current information appears sufficient for an initial analysis.',
      'normalize_duplicate_info' => 'The current information is sufficient to identify this as a duplicate, and no extra details are required.'
    }
  end

if prompt_source == default_prompt
  replace_tokens = lambda do |value|
    case value
    when String
      value.gsub('{{output_language_name}}', language_profile.fetch('prompt_language_name'))
    when Array
      value.map { |item| replace_tokens.call(item) }
    when Hash
      value.each_with_object({}) { |(key, nested_value), acc| acc[key] = replace_tokens.call(nested_value) }
    else
      value
    end
  end

  prompt = replace_tokens.call(prompt)
end

model_override = ENV['INPUT_MODEL'].to_s.strip
prompt['model'] = model_override unless model_override.empty?

# Keep the pre-migration bundled default for the explicit compatibility path.
# Copilot must be allowed to choose a currently available default model instead
# of receiving a stale provider-specific model name.
if transport == 'openai-compatible' && prompt_source == default_prompt && model_override.empty? && prompt['model'].to_s.strip.empty?
  prompt['model'] = 'gpt-4.1'
end

resolved_model = prompt['model'].to_s.strip

if transport == 'openai-compatible'
  legacy_model_match = resolved_model.match(/\Aopenai\/(.+)\z/i)
  if legacy_model_match
    converted_model = legacy_model_match[1].to_s.strip
    if converted_model.empty? || converted_model.include?('/')
      abort("Model #{resolved_model.inspect} cannot be converted for the OpenAI-compatible transport. Use a model name such as gpt-4.1 or the provider's documented model identifier.")
    end
    resolved_model = converted_model
    prompt['model'] = resolved_model
  end
end

if transport == 'copilot'
  unless resolved_model.empty?
    legacy_model_match = resolved_model.match(/\Aopenai\/(.+)\z/i)
    if legacy_model_match
      converted_model = legacy_model_match[1].to_s.strip
      if converted_model.empty? || converted_model.include?('/')
        abort("Model #{resolved_model.inspect} cannot be converted to a Copilot model name. Use a Copilot model such as gpt-4.1.")
      end
      resolved_model = converted_model
    elsif resolved_model.include?('/')
      abort("Model #{resolved_model.inspect} is not a supported Copilot model name. Use a Copilot model such as gpt-4.1; legacy openai/<model> names are converted automatically.")
    end
    prompt['model'] = resolved_model
  else
    prompt.delete('model')
  end
end

File.write(ENV.fetch('RESOLVED_PROMPT_FILE'), YAML.dump(prompt))

resolved_response_format = prompt['responseFormat'].to_s.strip
resolved_model_parameters =
  case prompt['modelParameters']
  when Hash
    prompt['modelParameters']
  else
    {}
  end

detect_placeholder_indent = lambda do |placeholder|
  pattern = /\A(\s*)\{\{#{Regexp.escape(placeholder)}\}\}\s*\z/
  File.foreach(ENV.fetch('RESOLVED_PROMPT_FILE')) do |line|
    match = line.match(pattern)
    return match[1] if match
  end
  '    '
end

file_input_indent_map = {
  'issue_title' => detect_placeholder_indent.call('issue_title'),
  'current_labels' => detect_placeholder_indent.call('current_labels'),
  'issue_body' => detect_placeholder_indent.call('issue_body'),
  'recent_comments' => detect_placeholder_indent.call('recent_comments'),
  'open_issues' => detect_placeholder_indent.call('open_issues')
}

default_label_map = {
  'bug' => 'bug',
  'question' => 'question',
  'enhancement' => 'enhancement',
  'documentation' => 'documentation',
  'duplicate' => 'duplicate',
  'needs-info' => 'needs-info'
}

label_map_file = ENV['INPUT_LABEL_MAP_FILE'].to_s.strip
label_map_inline = ENV['INPUT_LABEL_MAP'].to_s
parsed_label_map =
  if !label_map_file.empty?
    unless File.exist?(label_map_file)
      abort("Label map file not found: #{label_map_file}")
    end
    parse_label_map_file.call(label_map_file)
  elsif !label_map_inline.strip.empty?
    parse_label_map_inline.call(label_map_inline)
  else
    {}
  end

unless parsed_label_map.is_a?(Hash)
  abort('label-map configuration must resolve to a mapping')
end

extract_rerun_labels = lambda do |raw|
  items =
    case raw
    when nil
      []
    when Array
      raw.flatten.compact.map(&:to_s)
    else
      raw.to_s.split(/[\n,]+/)
    end

  seen = {}
  normalized = []
  items.each do |item|
    label = item.to_s.strip
    next if label.empty?
    key = label.downcase
    next if seen[key]
    seen[key] = true
    normalized << label
  end
  normalized
end

raw_rerun_labels =
  parsed_label_map.delete('rerun-labels') ||
  parsed_label_map.delete('rerun_labels') ||
  parsed_label_map.delete('rerun')

allowed_label_keys = default_label_map.keys
unknown_label_keys =
  parsed_label_map.keys
    .map { |key| key.to_s.strip.downcase }
    .reject(&:empty?)
    .uniq - allowed_label_keys
unless unknown_label_keys.empty?
  abort("Unknown label-map keys: #{unknown_label_keys.join(', ')}. Supported keys: #{allowed_label_keys.join(', ')}, rerun")
end

rerun_labels = extract_rerun_labels.call(raw_rerun_labels)
rerun_labels = ['ai-rerun'] if rerun_labels.empty?

normalized_label_map = default_label_map.merge(
  parsed_label_map.each_with_object({}) do |(key, value), acc|
    label_key = key.to_s.strip.downcase
    next if label_key.empty?
    if value.is_a?(Array) || value.is_a?(Hash)
      abort("label-map value for #{label_key} must be a string")
    end
    label_value = value.to_s.strip
    next if label_value.empty?
    acc[label_key] = label_value
  end
)

managed_label_names = default_label_map.keys
  .map { |key| normalized_label_map[key].to_s.strip.downcase }
  .reject(&:empty?)
  .uniq
overlapping_rerun_labels = rerun_labels.select do |label|
  managed_label_names.include?(label.to_s.strip.downcase)
end
unless overlapping_rerun_labels.empty?
  abort("Rerun labels must not overlap mapped AI-managed labels: #{overlapping_rerun_labels.join(', ')}")
end

normalized_ignore_label = ENV['INPUT_IGNORE_LABEL'].to_s.strip.downcase
if normalized_ignore_label != '' && managed_label_names.include?(normalized_ignore_label)
  abort("ignore-label must not overlap mapped AI-managed labels: #{ENV['INPUT_IGNORE_LABEL'].to_s.strip}")
end
overlapping_ignore_rerun_labels = rerun_labels.select do |label|
  normalized_ignore_label != '' && label.to_s.strip.downcase == normalized_ignore_label
end
unless overlapping_ignore_rerun_labels.empty?
  abort("Rerun labels must not overlap ignore-label: #{overlapping_ignore_rerun_labels.join(', ')}")
end

File.open(ENV.fetch('GITHUB_OUTPUT'), 'a') do |f|
  f.puts("resolved_prompt_file=#{ENV.fetch('RESOLVED_PROMPT_FILE')}")
  f.puts("label_map_json=#{JSON.generate(normalized_label_map)}")
  f.puts("language_profile_json=#{JSON.generate(language_profile)}")
  f.puts("rerun_labels_json=#{JSON.generate(rerun_labels)}")
  f.puts("file_input_indent_json=#{JSON.generate(file_input_indent_map)}")
  f.puts("resolved_model=#{resolved_model}")
  f.puts("resolved_response_format=#{resolved_response_format}")
  f.puts("resolved_model_parameters_json=#{JSON.generate(resolved_model_parameters)}")
  f.puts("openai_compatible_response_format=#{openai_compatible_response_format}")
  f.puts("openai_compatible_headers_json=#{JSON.generate(openai_compatible_headers)}")
  f.puts("language=#{normalized_language}")
  f.puts("use_custom_endpoint=#{endpoint.empty? ? 'false' : 'true'}")
  f.puts("transport=#{transport}")
end
