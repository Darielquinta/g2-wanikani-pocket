import { loadSubjectCache, saveSubjectCache } from './storage'

const API_BASE = 'https://api.wanikani.com/v2/'
const REVISION = '20170710'

export type SubjectType = 'radical' | 'kanji' | 'vocabulary' | 'kana_vocabulary'

export interface WkCollection<T> {
  object: 'collection'
  url: string
  pages: {
    next_url: string | null
    previous_url: string | null
    per_page: number
  }
  total_count: number
  data_updated_at: string | null
  data: T[]
}

export interface WkResource<T> {
  id: number
  object: string
  url: string
  data_updated_at: string | null
  data: T
}

export interface WkReport<T> {
  object: 'report'
  url: string
  data_updated_at: string | null
  data: T
}

export interface AssignmentData {
  created_at: string
  subject_id: number
  subject_type: SubjectType
  level: number
  srs_stage: number
  unlocked_at: string | null
  started_at: string | null
  passed_at: string | null
  burned_at: string | null
  available_at: string | null
  resurrected_at: string | null
  hidden: boolean
}

export type AssignmentResource = WkResource<AssignmentData>

export interface Meaning {
  meaning: string
  primary: boolean
  accepted_answer: boolean
}

export interface AuxiliaryMeaning {
  meaning: string
  type: 'whitelist' | 'blacklist'
}

export interface Reading {
  type?: string
  primary: boolean
  accepted_answer: boolean
  reading: string
}

export interface SubjectData {
  level: number
  slug: string
  hidden_at: string | null
  document_url: string
  characters: string | null
  meanings: Meaning[]
  auxiliary_meanings?: AuxiliaryMeaning[]
  readings?: Reading[]
  meaning_mnemonic?: string
  reading_mnemonic?: string
  parts_of_speech?: string[]
  component_subject_ids?: number[]
}

export type SubjectResource = WkResource<SubjectData> & { object: SubjectType }

export interface StudyMaterialData {
  created_at: string
  subject_id: number
  subject_type: SubjectType
  meaning_note: string | null
  reading_note: string | null
  meaning_synonyms: string[]
}

export type StudyMaterialResource = WkResource<StudyMaterialData> & { object: 'study_material' }

export interface SummaryData {
  lessons: Array<{ available_at: string; subject_ids: number[] }>
  next_reviews_at: string | null
  reviews: Array<{ available_at: string; subject_ids: number[] }>
}

export interface UserData {
  username: string
  level: number
  profile_url: string
  current_vacation_started_at: string | null
  subscription: {
    active: boolean
    type: string
    max_level_granted: number
    period_ends_at: string | null
  }
}

export class WaniKaniError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly url?: string,
  ) {
    super(message)
    this.name = 'WaniKaniError'
  }
}

export interface StudyItem {
  assignment: AssignmentResource
  subject: SubjectResource
  studyMaterial?: StudyMaterialResource
  componentSubjects?: SubjectResource[]
}

export class WaniKaniClient {
  private subjectCache = loadSubjectCache<SubjectResource>()

  constructor(private token: string) {}

  setToken(token: string): void {
    this.token = token.trim()
  }

  async getUser(): Promise<WkResource<UserData>> {
    return this.request<WkResource<UserData>>('user')
  }

  async getSummary(): Promise<WkReport<SummaryData>> {
    return this.request<WkReport<SummaryData>>('summary')
  }

  async getAvailableAssignments(kind: 'reviews' | 'lessons'): Promise<AssignmentResource[]> {
    const flag = kind === 'reviews' ? 'immediately_available_for_review' : 'immediately_available_for_lessons'
    return this.getAllPages<AssignmentResource>(`assignments?${flag}=true&hidden=false`)
  }

  async getSubjects(ids: number[]): Promise<Record<number, SubjectResource>> {
    const uniqueIds = Array.from(new Set(ids.filter(Number)))
    const out: Record<number, SubjectResource> = {}
    const missing: number[] = []

    for (const id of uniqueIds) {
      const cached = this.subjectCache[String(id)]
      if (cached) out[id] = cached
      else missing.push(id)
    }

    for (const chunk of chunkArray(missing, 100)) {
      const params = new URLSearchParams()
      params.set('ids', chunk.join(','))
      const subjects = await this.getAllPages<SubjectResource>(`subjects?${params.toString()}`)
      for (const subject of subjects) {
        this.subjectCache[String(subject.id)] = subject
        out[subject.id] = subject
      }
    }

    if (missing.length) saveSubjectCache(this.subjectCache)
    return out
  }

  async getStudyMaterials(ids: number[]): Promise<Record<number, StudyMaterialResource>> {
    const uniqueIds = Array.from(new Set(ids.filter(Number)))
    const out: Record<number, StudyMaterialResource> = {}

    for (const chunk of chunkArray(uniqueIds, 100)) {
      const params = new URLSearchParams()
      params.set('subject_ids', chunk.join(','))
      const materials = await this.getAllPages<StudyMaterialResource>(`study_materials?${params.toString()}`)
      for (const material of materials) {
        out[material.data.subject_id] = material
      }
    }

    return out
  }

  async getStudyItems(kind: 'reviews' | 'lessons', limit = 40): Promise<StudyItem[]> {
    const assignments = (await this.getAvailableAssignments(kind)).slice(0, limit)
    const subjectIds = assignments.map(item => item.data.subject_id)
    const [subjectsById, studyMaterialsBySubjectId] = await Promise.all([
      this.getSubjects(subjectIds),
      this.getStudyMaterials(subjectIds).catch(() => ({} as Record<number, StudyMaterialResource>)),
    ])

    const componentIds = Object.values(subjectsById)
      .flatMap(subject => subject.data.component_subject_ids || [])
    const componentSubjectsById = componentIds.length ? await this.getSubjects(componentIds) : {}

    const items: StudyItem[] = []
    for (const assignment of assignments) {
      const subject = subjectsById[assignment.data.subject_id]
      if (!subject) continue

      const item: StudyItem = { assignment, subject }
      const studyMaterial = studyMaterialsBySubjectId[assignment.data.subject_id]
      if (studyMaterial) item.studyMaterial = studyMaterial
      const componentSubjects = (subject.data.component_subject_ids || [])
        .map(id => componentSubjectsById[id])
        .filter((component): component is SubjectResource => Boolean(component))
      if (componentSubjects.length) item.componentSubjects = componentSubjects
      items.push(item)
    }

    return items
  }

  async createReview(input: {
    assignmentId: number
    incorrectMeaningAnswers: number
    incorrectReadingAnswers: number
  }): Promise<unknown> {
    return this.request('reviews', {
      method: 'POST',
      body: JSON.stringify({
        review: {
          assignment_id: input.assignmentId,
          incorrect_meaning_answers: Math.max(0, Math.trunc(input.incorrectMeaningAnswers)),
          incorrect_reading_answers: Math.max(0, Math.trunc(input.incorrectReadingAnswers)),
        },
      }),
    })
  }

  async startAssignment(assignmentId: number): Promise<AssignmentResource> {
    return this.request<AssignmentResource>(`assignments/${assignmentId}/start`, {
      method: 'PUT',
      body: JSON.stringify({ assignment: {} }),
    })
  }

  private async getAllPages<T>(path: string): Promise<T[]> {
    const results: T[] = []
    let next: string | null = path

    while (next) {
      const page: WkCollection<T> = await this.request<WkCollection<T>>(next)
      results.push(...page.data)
      next = page.pages?.next_url || null
      if (results.length > 2000) break
    }

    return results
  }

  private async request<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : API_BASE + pathOrUrl.replace(/^\//, '')
    if (!this.token) throw new WaniKaniError('Missing WaniKani API token.', 0, undefined, url)

    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    headers.set('Wanikani-Revision', REVISION)
    headers.set('Accept', 'application/json')
    if (init.body) headers.set('Content-Type', 'application/json; charset=utf-8')

    const response = await fetch(url, { ...init, headers })
    const text = await response.text()
    const body = text ? safeJson(text) : null

    if (!response.ok) {
      const message = errorMessage(body) || `${response.status} ${response.statusText}`
      throw new WaniKaniError(message, response.status, errorCode(body), url)
    }

    return body as T
  }
}

export function acceptedMeanings(subject: SubjectResource, studyMaterial?: StudyMaterialResource): string[] {
  const primary = subject.data.meanings.filter(item => item.accepted_answer).map(item => item.meaning)
  const whitelist = (subject.data.auxiliary_meanings || [])
    .filter(item => item.type === 'whitelist')
    .map(item => item.meaning)
  const userSynonyms = studyMaterial?.data.meaning_synonyms || []
  return uniqueClean([...primary, ...whitelist, ...userSynonyms])
}

export function acceptedReadings(subject: SubjectResource): string[] {
  return uniqueClean((subject.data.readings || []).filter(item => item.accepted_answer).map(item => item.reading))
}

export function hasReadingQuestion(subject: SubjectResource): boolean {
  return subject.object !== 'radical' && acceptedReadings(subject).length > 0
}

export function displaySubject(subject: SubjectResource): string {
  return subject.data.characters || subject.data.slug || `[${subject.object}]`
}

export function subjectKindLabel(subject: SubjectResource): string {
  switch (subject.object) {
    case 'radical': return 'Radical'
    case 'kanji': return 'Kanji'
    case 'vocabulary': return 'Vocabulary'
    case 'kana_vocabulary': return 'Kana vocab'
    default: return subject.object
  }
}

export function stripHtml(input: string | undefined): string {
  if (!input) return ''
  const doc = new DOMParser().parseFromString(input.replace(/<br\s*\/?/gi, '\n'), 'text/html')
  return (doc.body.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function meaningMatches(answer: string, item: StudyItem): boolean {
  const guess = normalizeMeaning(answer)
  if (!guess) return false
  return acceptedMeanings(item.subject, item.studyMaterial).some(candidate => normalizeMeaning(candidate) === guess)
}

export function readingMatches(answer: string, subject: SubjectResource): boolean {
  const guess = normalizeReading(answer)
  if (!guess) return false
  return acceptedReadings(subject).some(candidate => normalizeReading(candidate) === guess)
}

export function normalizeMeaning(input: string): string {
  return input
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[\s\-_]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
}

export function normalizeReading(input: string): string {
  return toHiragana(input.normalize('NFKC').trim().toLocaleLowerCase())
    .replace(/[\s\-・ー]/g, '')
}

export function toHiragana(input: string): string {
  const kana = katakanaToHiragana(input.normalize('NFKC').toLocaleLowerCase())
  return romajiToHiragana(expandRomajiLongVowels(kana))
}

export function shortError(error: unknown): string {
  if (error instanceof WaniKaniError) {
    if (error.status === 401) return 'Token rejected. Check the key.'
    if (error.status === 403) return 'WaniKani said no. Your token probably needs write access.'
    if (error.status === 429) return 'Rate limited. Give the crabigator a second.'
    return `${error.status || 'Net'}: ${error.message}`
  }
  if (error instanceof TypeError) return 'Network/CORS failed.'
  if (error instanceof Error) return error.message
  return 'Unknown error.'
}

function katakanaToHiragana(input: string): string {
  return input.replace(/[ァ-ン]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60))
}

function romajiToHiragana(input: string): string {
  const table: Record<string, string> = {
    a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
    ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
    kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
    ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
    gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
    sa: 'さ', shi: 'し', si: 'し', su: 'す', se: 'せ', so: 'そ',
    sha: 'しゃ', shu: 'しゅ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
    za: 'ざ', ji: 'じ', zi: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
    ja: 'じゃ', ju: 'じゅ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
    ta: 'た', chi: 'ち', ti: 'ち', tsu: 'つ', tu: 'つ', te: 'て', to: 'と',
    cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
    da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
    dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ',
    na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
    nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
    ha: 'は', hi: 'ひ', fu: 'ふ', hu: 'ふ', he: 'へ', ho: 'ほ',
    hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
    ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
    bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
    pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
    pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
    ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
    mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
    ya: 'や', yu: 'ゆ', yo: 'よ',
    ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
    rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
    wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を', n: 'ん',
    la: 'ぁ', li: 'ぃ', lu: 'ぅ', le: 'ぇ', lo: 'ぉ',
    xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ',
    lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ', xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ',
    ltsu: 'っ', xtsu: 'っ', ltu: 'っ', xtu: 'っ',
    va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
  }

  let out = ''
  let i = 0
  while (i < input.length) {
    const char = input[i]
    const next = input[i + 1]

    if (!/[a-z]/.test(char)) {
      out += char
      i += 1
      continue
    }

    if (char === 'n') {
      const following = input[i + 1]
      if (!following || following === "'" || !/[aeiouy]/.test(following)) {
        out += 'ん'
        i += following === "'" ? 2 : 1
        continue
      }
    }

    if (next && char === next && !'aeioun'.includes(char)) {
      out += 'っ'
      i += 1
      continue
    }

    const tri = input.slice(i, i + 3)
    const pair = input.slice(i, i + 2)
    if (table[tri]) {
      out += table[tri]
      i += 3
      continue
    }
    if (table[pair]) {
      out += table[pair]
      i += 2
      continue
    }
    if (table[char]) {
      out += table[char]
      i += 1
      continue
    }

    out += char
    i += 1
  }

  return out
}

function expandRomajiLongVowels(input: string): string {
  return input
    .replace(/ā/g, 'aa')
    .replace(/ī/g, 'ii')
    .replace(/ū/g, 'uu')
    .replace(/ē/g, 'ee')
    .replace(/ō/g, 'ou')
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  if (typeof record.message === 'string') return record.message
  return undefined
}

function errorCode(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const code = (body as Record<string, unknown>).code
  return typeof code === 'number' ? code : undefined
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

function uniqueClean(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const value = item.trim()
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}
