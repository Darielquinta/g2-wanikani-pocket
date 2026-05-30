import {
  acceptedMeanings,
  acceptedReadings,
  displaySubject,
  hasReadingQuestion,
  normalizeMeaning,
  normalizeReading,
  stripHtml,
  subjectKindLabel,
  type StudyItem,
  type SubjectResource,
} from './wanikani'

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o-mini'

export interface TroubleEntry {
  subjectId: number
  subjectType: string
  part: 'meaning' | 'reading'
  given: string
  expected: string[]
  at: string
}

export interface MnemonicSuggestionInput {
  subject: SubjectResource
  misses: TroubleEntry[]
  componentSubjects: SubjectResource[]
}

export interface AnswerReportResult {
  accepted: boolean
  confidence: 'low' | 'medium' | 'high'
  reason: string
}

export async function askAiForCoach(apiKey: string, items: MnemonicSuggestionInput[]): Promise<string> {
  if (!apiKey.trim()) throw new Error('Missing ChatGPT API key.')
  if (!items.length) return 'No missed review data yet. Do a few reviews first, then come back for targeted coaching.'

  const compactItems = items.map(item => ({
    item: displaySubject(item.subject),
    type: subjectKindLabel(item.subject),
    meanings: acceptedMeanings(item.subject).slice(0, 5),
    readings: acceptedReadings(item.subject).slice(0, 5),
    missed_parts: summarizeMisses(item.misses),
    radicals: radicalNames(item.componentSubjects),
    components: item.componentSubjects
      .filter(component => component.object !== 'radical')
      .map(component => `${displaySubject(component)} (${acceptedMeanings(component).slice(0, 2).join('/') || component.data.slug})`)
      .slice(0, 8),
    existing_meaning_mnemonic: stripHtml(item.subject.data.meaning_mnemonic).slice(0, 700),
    existing_reading_mnemonic: stripHtml(item.subject.data.reading_mnemonic).slice(0, 500),
  }))

  const content = await callChat(apiKey, [
    {
      role: 'system',
      content: 'You are a concise WaniKani tutor for smart glasses. Identify patterns in missed vocabulary/kanji and suggest memorable new mnemonics grounded in radicals/components. Keep output under 900 characters, plain text, no markdown tables.',
    },
    {
      role: 'user',
      content: `Analyze these troublesome WaniKani items and suggest fresh mnemonics based on radicals/components. Prioritize the most repeated misses. Data: ${JSON.stringify(compactItems)}`,
    },
  ], 950)

  return content.trim() || 'AI coach returned an empty response.'
}

export async function askAiToJudgeAnswer(apiKey: string, item: StudyItem, part: 'meaning' | 'reading', given: string): Promise<AnswerReportResult> {
  if (!apiKey.trim()) throw new Error('Missing ChatGPT API key.')

  const expected = part === 'meaning' ? acceptedMeanings(item.subject, item.studyMaterial) : acceptedReadings(item.subject)
  const localNormalized = part === 'meaning' ? normalizeMeaning(given) : normalizeReading(given)
  const expectedNormalized = expected.map(answer => part === 'meaning' ? normalizeMeaning(answer) : normalizeReading(answer))

  const content = await callChat(apiKey, [
    {
      role: 'system',
      content: 'You judge WaniKani review answers. Return only strict JSON: {"accepted": boolean, "confidence": "low"|"medium"|"high", "reason": string}. Accept only true typos, equivalent English meanings, or kana readings that clearly match. Reject different meanings/readings, vague answers, and blacklisted meanings.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        subject: displaySubject(item.subject),
        type: item.subject.object,
        question: part,
        user_answer: given,
        accepted_answers: expected,
        normalized_user_answer: localNormalized,
        normalized_accepted_answers: expectedNormalized,
        blacklisted_meanings: (item.subject.data.auxiliary_meanings || []).filter(meaning => meaning.type === 'blacklist').map(meaning => meaning.meaning),
        meanings: item.subject.data.meanings,
        readings: item.subject.data.readings || [],
      }),
    },
  ], 220)

  return parseJudgeResult(content)
}

function summarizeMisses(misses: TroubleEntry[]): string[] {
  return misses.slice(-6).map(miss => `${miss.part}: "${miss.given}" expected ${miss.expected.slice(0, 3).join('/')}`)
}

export function radicalNames(subjects: SubjectResource[]): string[] {
  return subjects
    .filter(subject => subject.object === 'radical')
    .map(subject => `${displaySubject(subject)} (${acceptedMeanings(subject).slice(0, 2).join('/') || subject.data.slug})`)
    .slice(0, 10)
}

async function callChat(apiKey: string, messages: Array<{ role: 'system' | 'user'; content: string }>, maxTokens: number): Promise<string> {
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  })

  const text = await response.text()
  const body = safeJson(text)
  if (!response.ok) {
    const message = extractError(body) || `${response.status} ${response.statusText}`
    throw new Error(`ChatGPT: ${message}`)
  }

  const choice = body && typeof body === 'object'
    ? (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
    : undefined
  return choice?.message?.content || ''
}

function parseJudgeResult(content: string): AnswerReportResult {
  const parsed = safeJson(content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim())
  if (!parsed || typeof parsed !== 'object') {
    return { accepted: false, confidence: 'low', reason: 'AI response was not valid JSON.' }
  }

  const record = parsed as Record<string, unknown>
  const confidence = record.confidence === 'high' || record.confidence === 'medium' || record.confidence === 'low'
    ? record.confidence
    : 'low'
  return {
    accepted: record.accepted === true,
    confidence,
    reason: typeof record.reason === 'string' ? record.reason.slice(0, 260) : 'No reason given.',
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function extractError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const error = (body as Record<string, unknown>).error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return undefined
}
