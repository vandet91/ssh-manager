export type AnalysisType = 'health' | 'security' | 'performance' | 'errors' | 'custom'
export type AiProvider = 'claude' | 'openai' | 'gemini' | 'deepseek'

export interface AssistantReply {
  answer: string       // markdown-ish plain text explanation
  commands: string[]   // suggested shell commands the user can run
}

const ASSISTANT_SYSTEM_PROMPT = `You are an expert sysadmin assistant embedded in an SSH terminal tool.
The user is connected to a server and needs quick help: looking up a command, or diagnosing a problem.
Respond with ONLY a valid JSON object of this exact shape:
{
  "answer": "concise, practical explanation in plain text (may use simple markdown). Keep it short and directly useful.",
  "commands": ["exact runnable command", "another if helpful"]
}
Rules:
- Return ONLY valid JSON. No markdown code fences, no prose outside JSON.
- Tailor every command to the given OS (Linux shell vs Windows PowerShell/cmd).
- "commands" holds ready-to-run commands (use placeholders like <name> only when unavoidable). Empty array if none apply.
- Be concise. Prefer the safest command that answers the question.`

/**
 * Free-form terminal assistant: answers a question and suggests commands.
 * Reuses the same provider plumbing as the analyst but with a chat-style prompt.
 */
export async function askAssistant(
  provider: AiProvider,
  model: string,
  apiKey: string,
  question: string,
  osType: string,
  context: string,
): Promise<AssistantReply> {
  const os = osType === 'windows' ? 'Windows (PowerShell/cmd)' : 'Linux (bash)'
  const ctx = context.trim() ? `\n\nRECENT TERMINAL OUTPUT (most recent last):\n${context.slice(-6000)}` : ''
  const userPrompt = `SERVER OS: ${os}\n\nUSER QUESTION: ${question}${ctx}`

  let rawText = ''
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, system: ASSISTANT_SYSTEM_PROMPT, messages: [{ role: 'user', content: userPrompt }] }),
    })
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`)
    const data = await res.json() as any
    rawText = data.content?.[0]?.text ?? ''
  } else if (provider === 'openai' || provider === 'deepseek') {
    const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com'
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }, { role: 'user', content: userPrompt }] }),
    })
    if (!res.ok) throw new Error(`${provider === 'deepseek' ? 'DeepSeek' : 'OpenAI'} API error ${res.status}: ${await res.text()}`)
    const data = await res.json() as any
    rawText = data.choices?.[0]?.message?.content ?? ''
  } else if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${ASSISTANT_SYSTEM_PROMPT}\n\n${userPrompt}` }] }],
        generationConfig: { maxOutputTokens: 1500, responseMimeType: 'application/json' } }),
    })
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`)
    const data = await res.json() as any
    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }

  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    const parsed = JSON.parse(rawText)
    return {
      answer: typeof parsed.answer === 'string' ? parsed.answer : '',
      commands: Array.isArray(parsed.commands) ? parsed.commands.filter((c: unknown) => typeof c === 'string') : [],
    }
  } catch {
    // If the model didn't return JSON, treat the whole thing as the answer.
    return { answer: rawText || 'No response from AI.', commands: [] }
  }
}

export interface AnalysisIssue {
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  service?: string | null
  timestamp?: string | null
  root_cause?: string | null
  fix_commands?: string[]
  prevention?: string | null
}

export interface AnalysisResult {
  summary: string
  health_score: number
  issues: AnalysisIssue[]
  security_alerts: AnalysisIssue[]
  recommendations: string[]
  raw_provider: AiProvider
  raw_model: string
  analysed_at: string
}

const SYSTEM_PROMPT = `You are an expert Linux SRE and security analyst with 15+ years of experience.
Analyse the provided server logs and respond with ONLY a valid JSON object using this exact structure:
{
  "summary": "2-3 sentence plain-English assessment of the server state",
  "health_score": <integer 0-100, 100=perfect health>,
  "issues": [
    {
      "severity": "critical|warning|info",
      "title": "Short descriptive title (max 80 chars)",
      "description": "What is happening and what impact it has",
      "service": "affected service/process name or null",
      "timestamp": "approximate time from logs or null",
      "root_cause": "concise explanation of WHY this is happening",
      "fix_commands": ["exact shell command to fix", "follow-up command if needed"],
      "prevention": "how to prevent this in future"
    }
  ],
  "security_alerts": [same structure — only for security/intrusion concerns],
  "recommendations": ["actionable recommendation", "another recommendation"]
}
Rules:
- Return ONLY valid JSON. No markdown fences, no prose outside JSON.
- Sort issues by severity: critical first, then warning, then info.
- fix_commands must be real, runnable Linux shell commands.
- If no issues found, return empty arrays.
- health_score: 0-40 = critical problems, 41-69 = degraded, 70-89 = mostly healthy, 90-100 = excellent.`

function buildUserPrompt(type: AnalysisType, question: string | undefined, logs: string): string {
  const focus: Record<AnalysisType, string> = {
    health:      'Perform a comprehensive health check. Identify ALL errors, warnings, crashes, resource issues, and anomalies.',
    security:    'Focus exclusively on security: failed SSH logins, brute force attempts, privilege escalation, suspicious IPs, unusual cron changes, rootkit signs, unexpected processes.',
    performance: 'Focus on performance: high CPU/memory/disk usage warnings, OOM kills, slow queries, timeouts, swap usage, I/O bottlenecks, network issues.',
    errors:      'Focus on errors and failures: service crashes, panics, segfaults, failed systemd units, application exceptions, database errors.',
    custom:      question ?? 'Perform a general analysis of these logs.',
  }
  return `ANALYSIS FOCUS: ${focus[type]}\n\nSERVER LOGS:\n${logs}`
}

export async function callAiProvider(
  provider: AiProvider,
  model: string,
  apiKey: string,
  analysisType: AnalysisType,
  customQuestion: string | undefined,
  logs: string,
): Promise<AnalysisResult> {
  const userPrompt = buildUserPrompt(analysisType, customQuestion, logs)
  let rawText = ''

  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${err}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any
    rawText = data.content?.[0]?.text ?? ''

  } else if (provider === 'openai' || provider === 'deepseek') {
    const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com'
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`${provider === 'deepseek' ? 'DeepSeek' : 'OpenAI'} API error ${res.status}: ${err}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any
    rawText = data.choices?.[0]?.message?.content ?? ''

  } else if (provider === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }] }],
          generationConfig: { maxOutputTokens: 4096, responseMimeType: 'application/json' },
        }),
      },
    )
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gemini API error ${res.status}: ${err}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any
    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }

  // Strip markdown code fences that some models add despite instructions
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  try {
    const parsed = JSON.parse(rawText)
    return {
      summary:         parsed.summary ?? '',
      health_score:    Number(parsed.health_score ?? 50),
      issues:          Array.isArray(parsed.issues) ? parsed.issues : [],
      security_alerts: Array.isArray(parsed.security_alerts) ? parsed.security_alerts : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      raw_provider:    provider,
      raw_model:       model,
      analysed_at:     new Date().toISOString(),
    }
  } catch {
    throw new Error(`AI returned invalid JSON. Raw response: ${rawText.slice(0, 300)}`)
  }
}
