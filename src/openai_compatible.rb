require 'json'
require 'net/http'
require 'openssl'
require 'tmpdir'
require 'uri'
require 'yaml'

class OpenAICompatibleError < StandardError
  attr_reader :status, :response_format_error

  def initialize(message, status: nil, response_format_error: false)
    super(message)
    @status = status
    @response_format_error = response_format_error
  end
end

def output_value(value)
  String(value || '').gsub(/[\r\n]/, ' ').strip
end

def set_output(name, value)
  output_file = ENV['GITHUB_OUTPUT'].to_s
  return if output_file.empty?

  File.open(output_file, 'a') do |file|
    file.puts("#{name}=#{output_value(value)}")
  end
end

def diagnostic_message(error)
  message = String(error.message || error).strip
  token = ENV['OPENAI_COMPAT_TOKEN'].to_s
  message = message.gsub(token, '[REDACTED]') unless token.empty?
  output_value(message)[0, 2000]
end

def fail_inference(error)
  set_output('response-file', '')
  set_output('response-mode', '')
  set_output('error', diagnostic_message(error))
  warn("OpenAI-compatible inference failed: #{diagnostic_message(error)}")
  exit 1
end

def read_optional_file(name)
  file = ENV[name].to_s
  return '' if file.empty?

  File.read(file)
end

def expand_prompt(value, variables)
  case value
  when String
    value.gsub(/\{\{([A-Za-z0-9_.-]+)\}\}/) do
      key = Regexp.last_match(1)
      variables.key?(key) ? variables.fetch(key).to_s : Regexp.last_match(0)
    end
  when Array
    value.map { |item| expand_prompt(item, variables) }
  when Hash
    value.each_with_object({}) do |(key, nested_value), result|
      result[key] = expand_prompt(nested_value, variables)
    end
  else
    value
  end
end

def response_format_error?(status, message)
  [400, 422].include?(status.to_i) && message.match?(/response[\s_-]*format|json[\s_-]*(?:schema|object)/i)
end

def normalize_schema(raw_schema)
  return nil if raw_schema.nil?

  schema = if raw_schema.is_a?(String)
             begin
               JSON.parse(raw_schema)
             rescue JSON::ParserError => error
               raise OpenAICompatibleError, "openai-compatible-invalid-json-schema: #{error.message}"
             end
           else
             raw_schema
           end
  unless schema.is_a?(Hash)
    raise OpenAICompatibleError, 'openai-compatible-invalid-json-schema: expected a JSON object'
  end
  schema
end

def extract_error_message(body)
  parsed = JSON.parse(body)
  error = parsed.is_a?(Hash) ? parsed['error'] : nil
  if error.is_a?(Hash)
    error['message'] || error['detail'] || error['code']
  elsif error
    error
  elsif parsed.is_a?(Hash)
    parsed['message'] || parsed['detail'] || parsed['code']
  end
rescue JSON::ParserError
  nil
end

def build_request_uri(endpoint)
  uri = URI.parse(endpoint)
  unless %w[http https].include?(uri.scheme) && !uri.host.to_s.empty?
    raise OpenAICompatibleError, 'openai-compatible-invalid-endpoint: endpoint must be an http(s) URL'
  end
  if uri.user || uri.password
    raise OpenAICompatibleError, 'openai-compatible-invalid-endpoint: credentials must be passed through the token input'
  end

  path = uri.path.to_s.sub(%r{/+\z}, '')
  path = '/chat/completions' if path.empty?
  path = "#{path}/chat/completions" unless path.end_with?('/chat/completions')
  uri.path = path
  uri
rescue URI::InvalidURIError => error
  raise OpenAICompatibleError, "openai-compatible-invalid-endpoint: #{error.message}"
end

def response_content(payload)
  unless payload.is_a?(Hash) && payload['choices'].is_a?(Array)
    raise OpenAICompatibleError, 'openai-compatible-invalid-response: response choices are missing'
  end

  message = payload['choices'].first.is_a?(Hash) ? payload['choices'].first['message'] : nil
  content = message.is_a?(Hash) ? message['content'] : nil
  if content.nil?
    raise OpenAICompatibleError, 'openai-compatible-empty-response: response content is missing'
  end
  if content.is_a?(Array)
    content = content.each_with_object([]) do |part, parts|
      value = part.is_a?(Hash) ? (part['text'] || part['content']) : part.to_s
      parts << value unless value.nil?
    end.join
  end
  content = JSON.generate(content) unless content.is_a?(String)
  if content.to_s.strip.empty?
    raise OpenAICompatibleError, 'openai-compatible-empty-response: response content is empty'
  end
  content.to_s
end

def request_body(messages, model, model_parameters, mode, schema)
  body = {
    'model' => model,
    'messages' => messages
  }

  parameters = model_parameters.is_a?(Hash) ? model_parameters : {}
  max_tokens = parameters['maxCompletionTokens'] || parameters['max_tokens']
  body['max_tokens'] = Integer(max_tokens) if max_tokens
  body['temperature'] = parameters['temperature'] if parameters.key?('temperature')
  top_p = parameters['topP'] || parameters['top_p']
  body['top_p'] = top_p if top_p

  case mode
  when 'json_schema'
    body['response_format'] = {
      'type' => 'json_schema',
      'json_schema' => schema
    }
  when 'json_object'
    body['response_format'] = { 'type' => 'json_object' }
  when 'prompt'
    # The system prompt carries the JSON-only constraint for providers that do
    # not implement OpenAI's response_format parameter.
  else
    raise OpenAICompatibleError, "openai-compatible-invalid-response-format: #{mode}"
  end
  body
rescue ArgumentError, TypeError
  raise OpenAICompatibleError, 'openai-compatible-invalid-model-parameters: maxCompletionTokens must be an integer'
end

def add_prompt_only_instruction(messages, schema)
  instruction = 'Compatibility transport constraint: return exactly one valid JSON object, without markdown fences, commentary, or any text outside the JSON object.'
  if schema
    instruction += " The JSON object must also conform to this JSON Schema:\n#{JSON.generate(schema)}"
  end

  updated = messages.map { |message| message.dup }
  system_message = updated.find { |message| message.is_a?(Hash) && message['role'].to_s.downcase == 'system' }
  if system_message
    content = system_message['content']
    system_message['content'] = content.is_a?(String) ? "#{content}\n\n#{instruction}" : instruction
  else
    updated.unshift({ 'role' => 'system', 'content' => instruction })
  end
  updated
end

def perform_request(uri, headers, body, token)
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == 'https'
  http.verify_mode = OpenSSL::SSL::VERIFY_PEER if http.use_ssl?
  http.open_timeout = 20
  http.read_timeout = 120

  request = Net::HTTP::Post.new(uri.request_uri)
  headers.each { |name, value| request[name] = value }
  request['Authorization'] = "Bearer #{token}" unless headers.keys.any? { |name| name.casecmp?('Authorization') }
  request.body = JSON.generate(body)
  response = http.request(request)
  raw_body = response.body.to_s
  status = response.code.to_i

  unless status.between?(200, 299)
    message = extract_error_message(raw_body).to_s.strip
    message = raw_body.strip if message.empty?
    message = 'upstream returned an empty error response' if message.empty?
    message = message.gsub(/[\r\n]+/, ' ')[0, 1200]
    request_id = response['x-request-id'] || response['request-id']
    message = "#{message} (request id: #{request_id})" if request_id && !request_id.empty?
    raise OpenAICompatibleError.new(
      "openai-compatible-http-#{status}: #{message}",
      status: status,
      response_format_error: response_format_error?(status, message)
    )
  end

  begin
    JSON.parse(raw_body)
  rescue JSON::ParserError => error
    raise OpenAICompatibleError, "openai-compatible-invalid-response: upstream returned invalid JSON (#{error.message})"
  end
end

begin
  endpoint = ENV['OPENAI_COMPAT_ENDPOINT'].to_s.strip
  token = ENV['OPENAI_COMPAT_TOKEN'].to_s.strip
  raise OpenAICompatibleError, 'openai-compatible-missing-configuration: endpoint and token are required' if endpoint.empty? || token.empty?

  prompt_file = ENV['PROMPT_FILE'].to_s
  raise OpenAICompatibleError, 'openai-compatible-missing-prompt: resolved prompt file is missing' if prompt_file.empty? || !File.file?(prompt_file)

  raw_prompt = YAML.safe_load(File.read(prompt_file), aliases: false)
  raise OpenAICompatibleError, 'openai-compatible-invalid-prompt: expected a YAML object' unless raw_prompt.is_a?(Hash)

  variables = {
    'trigger_reason' => ENV['TRIGGER_REASON'].to_s,
    'issue_title' => read_optional_file('ISSUE_TITLE_FILE'),
    'current_labels' => read_optional_file('CURRENT_LABELS_FILE'),
    'issue_body' => read_optional_file('ISSUE_BODY_FILE'),
    'recent_comments' => read_optional_file('RECENT_COMMENTS_FILE'),
    'open_issues' => read_optional_file('OPEN_ISSUES_FILE')
  }
  prompt = expand_prompt(raw_prompt, variables)
  messages = prompt['messages']
  raise OpenAICompatibleError, 'openai-compatible-invalid-prompt: messages are missing' unless messages.is_a?(Array) && !messages.empty?
  unless messages.all? { |message| message.is_a?(Hash) && !message['role'].to_s.empty? && message.key?('content') }
    raise OpenAICompatibleError, 'openai-compatible-invalid-prompt: every message needs a role and content'
  end

  model = ENV['MODEL'].to_s.strip
  model = prompt['model'].to_s.strip if model.empty?
  raise OpenAICompatibleError, 'openai-compatible-model-missing: set model for the OpenAI-compatible transport' if model.empty?

  model_parameters = JSON.parse(ENV.fetch('MODEL_PARAMETERS_JSON', '{}'))
  schema = normalize_schema(prompt['jsonSchema'])
  requested_mode = ENV.fetch('OPENAI_COMPAT_RESPONSE_FORMAT', 'auto').to_s.strip.downcase
  unless %w[auto json_schema json_object prompt].include?(requested_mode)
    raise OpenAICompatibleError, "openai-compatible-invalid-response-format: #{requested_mode}"
  end

  modes = case requested_mode
          when 'auto'
            if prompt['responseFormat'].to_s == 'json_schema' && schema
              %w[json_schema json_object prompt]
            elsif prompt['responseFormat'].to_s == 'json_object'
              %w[json_object prompt]
            else
              ['prompt']
            end
          when 'json_schema'
            raise OpenAICompatibleError, 'openai-compatible-json-schema-missing: prompt does not define jsonSchema' unless schema
            ['json_schema']
          else
            [requested_mode]
          end

  uri = build_request_uri(endpoint)
  headers = JSON.parse(ENV.fetch('OPENAI_COMPAT_HEADERS_JSON', '{}'))
  raise OpenAICompatibleError, 'openai-compatible-invalid-headers: normalized headers must be an object' unless headers.is_a?(Hash)
  headers = headers.transform_keys(&:to_s).transform_values(&:to_s)
  headers['Content-Type'] = 'application/json' unless headers.keys.any? { |name| name.casecmp?('Content-Type') }
  headers['Accept'] = 'application/json' unless headers.keys.any? { |name| name.casecmp?('Accept') }

  attempted_modes = []
  last_error = nil
  modes.each do |mode|
    attempted_modes << mode
    request_messages = mode == 'json_schema' ? messages : add_prompt_only_instruction(messages, schema)
    body = request_body(request_messages, model, model_parameters, mode, schema)
    begin
      payload = perform_request(uri, headers, body, token)
      content = response_content(payload)
      response_file = File.join(
        ENV.fetch('RUNNER_TEMP', Dir.tmpdir),
        "issue-ai-analyze-openai-response-#{ENV.fetch('GITHUB_RUN_ID', 'run')}-#{Process.pid}.json"
      )
      File.write(response_file, content)
      set_output('response-file', response_file)
      set_output('response-mode', mode)
      set_output('error', '')
      puts "OpenAI-compatible response mode: #{mode}"
      exit 0
    rescue OpenAICompatibleError => error
      last_error = error
      retryable = error.response_format_error && mode != modes.last
      next if retryable

      break
    end
  end

  if last_error
    message = diagnostic_message(last_error)
    if attempted_modes.length > 1
      message = "#{message} (attempted response modes: #{attempted_modes.join(', ')})"
      last_error = OpenAICompatibleError.new(message)
    end
    fail_inference(last_error)
  end
  fail_inference(OpenAICompatibleError.new('openai-compatible-no-attempt-made'))
rescue Psych::Exception => error
  fail_inference(OpenAICompatibleError.new("openai-compatible-invalid-prompt: #{error.message.lines.first.to_s.strip}"))
rescue JSON::ParserError => error
  fail_inference(OpenAICompatibleError.new("openai-compatible-invalid-json: #{error.message}"))
rescue OpenAICompatibleError => error
  fail_inference(error)
rescue StandardError => error
  fail_inference(OpenAICompatibleError.new("openai-compatible-client-error: #{error.class}: #{error.message}"))
end
