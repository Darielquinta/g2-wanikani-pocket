import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { PersistStore, TOKEN_KEY } from './storage'
import {
  WaniKaniClient,
  acceptedMeanings,
  acceptedReadings,
  displaySubject,
  hasReadingQuestion,
  meaningMatches,
  readingMatches,
  shortError,
  stripHtml,
  subjectKindLabel,
  type StudyItem,
  type UserData,
  type WkResource,
} from './wanikani'

type Gesture = 'tap' | 'up' | 'down' | 'double'
type Mode = 'setup' | 'home' | 'loading' | 'message' | 'help' | 'reviewQuestion' | 'reviewCorrection' | 'lesson'
type ActionName = 'reviews' | 'lessons' | 'refresh' | 'help'
type ReviewPart = 'meaning' | 'reading'

interface Dashboard {
  user: WkResource<UserData> | null
  reviewCount: number
  lessonCount: number
  nextReviewsAt: string | null
  lastSync: string | null
}

interface ViewModel {
  header: string
  body: string
  footer: string
}

const HEADER_ID = 1
const BODY_ID = 2
const FOOTER_ID = 3
const EMPTY_DASHBOARD: Dashboard = {
  user: null,
  reviewCount: 0,
  lessonCount: 0,
  nextReviewsAt: null,
  lastSync: null,
}

class G2Display {
  private renderQueue: Promise<void> = Promise.resolve()

  constructor(private bridge: EvenAppBridge | null) {}

  async boot(initial: ViewModel): Promise<void> {
    if (!this.bridge) return

    const created = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3,
        textObject: [
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 36,
            borderWidth: 0,
            borderColor: 10,
            borderRadius: 0,
            paddingLength: 4,
            containerID: HEADER_ID,
            containerName: 'header',
            content: clip(initial.header, 900),
            isEventCapture: 0,
          }),
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 38,
            width: 576,
            height: 208,
            borderWidth: 1,
            borderColor: 7,
            borderRadius: 8,
            paddingLength: 6,
            containerID: BODY_ID,
            containerName: 'body',
            content: clip(initial.body, 900),
            isEventCapture: 1,
          }),
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 250,
            width: 576,
            height: 38,
            borderWidth: 0,
            borderColor: 10,
            borderRadius: 0,
            paddingLength: 4,
            containerID: FOOTER_ID,
            containerName: 'footer',
            content: clip(initial.footer, 900),
            isEventCapture: 0,
          }),
        ],
      }),
    )

    if (created !== 0) console.error('createStartUpPageContainer failed:', created)
  }

  render(model: ViewModel): void {
    if (!this.bridge) return
    this.renderQueue = this.renderQueue
      .then(async () => {
        await this.bridge!.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: HEADER_ID, containerName: 'header', content: clip(model.header, 1900) }),
        )
        await this.bridge!.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: BODY_ID, containerName: 'body', content: clip(model.body, 1900) }),
        )
        await this.bridge!.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: FOOTER_ID, containerName: 'footer', content: clip(model.footer, 1900) }),
        )
      })
      .catch(error => console.error('render failed:', error))
  }

  async shutdown(): Promise<void> {
    if (!this.bridge) return
    await this.bridge.shutDownPageContainer(1)
  }
}

class WaniPocketApp {
  private mode: Mode = 'setup'
  private store: PersistStore
  private token = ''
  private wk: WaniKaniClient | null = null
  private dashboard: Dashboard = { ...EMPTY_DASHBOARD }
  private homeIndex = 0
  private messageTitle = 'Message'
  private messageBody = ''
  private reviewQueue: StudyItem[] = []
  private reviewIndex = 0
  private reviewPart: ReviewPart = 'meaning'
  private reviewMeaningWrong = 0
  private reviewReadingWrong = 0
  private lastAnswerFeedback = ''
  private liveAnswer = ''
  private isComposingAnswer = false
  private ignoreNextAnswerSubmit = false
  private correctionItem: StudyItem | null = null
  private correctionPart: ReviewPart = 'meaning'
  private correctionGiven = ''
  private lessonQueue: StudyItem[] = []
  private lessonIndex = 0
  private lessonPage = 0
  private unsubscribe: (() => void) | null = null

  constructor(
    private bridge: EvenAppBridge | null,
    private display: G2Display,
  ) {
    this.store = new PersistStore(bridge)
  }

  async start(): Promise<void> {
    await this.display.boot(this.view())
    this.renderCompanionShell()

    if (this.bridge) {
      this.unsubscribe = this.bridge.onEvenHubEvent(event => this.handleEvenHubEvent(event))
      window.addEventListener('beforeunload', () => this.cleanup())
    }

    this.token = (await this.store.get(TOKEN_KEY)).trim()
    this.updateTokenInput()

    if (!this.token) {
      this.mode = 'setup'
      this.render()
      return
    }

    this.wk = new WaniKaniClient(this.token)
    await this.refreshDashboard(false)
  }

  private handleEvenHubEvent(event: EvenHubEvent): void {
    const sysType = event.sysEvent ? (event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT) : null
    const textType = event.textEvent ? event.textEvent.eventType : null

    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      this.handleGesture('double').catch(console.error)
      return
    }

    if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      this.handleGesture('up').catch(console.error)
      return
    }

    if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      this.handleGesture('down').catch(console.error)
      return
    }

    if (sysType === OsEventTypeList.CLICK_EVENT) {
      this.handleGesture('tap').catch(console.error)
      return
    }

    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      this.cleanup()
    }
  }

  private async handleGesture(gesture: Gesture): Promise<void> {
    switch (this.mode) {
      case 'setup':
        if (gesture === 'tap') await this.refreshDashboard(true)
        if (gesture === 'double') await this.display.shutdown()
        break
      case 'loading':
        if (gesture === 'double') this.goHome()
        break
      case 'home':
        await this.handleHomeGesture(gesture)
        break
      case 'help':
        if (gesture === 'double' || gesture === 'tap') this.goHome()
        break
      case 'message':
        if (gesture === 'tap' || gesture === 'double') this.goHome()
        break
      case 'reviewQuestion':
        if (gesture === 'double') this.goHome()
        if (gesture === 'tap') this.focusAnswerInput()
        break
      case 'reviewCorrection':
        if (gesture === 'double') this.goHome()
        else if (gesture === 'tap') this.continueAfterCorrection()
        break
      case 'lesson':
        await this.handleLessonGesture(gesture)
        break
    }
  }

  private async handleHomeGesture(gesture: Gesture): Promise<void> {
    if (gesture === 'double') {
      await this.display.shutdown()
      return
    }

    if (gesture === 'up' || gesture === 'down') {
      const delta = gesture === 'down' ? 1 : -1
      this.homeIndex = wrap(this.homeIndex + delta, this.homeActions().length)
      this.render()
      return
    }

    const action = this.homeActions()[this.homeIndex]?.name
    if (action === 'reviews') await this.startReviews()
    if (action === 'lessons') await this.startLessons()
    if (action === 'refresh') await this.refreshDashboard(true)
    if (action === 'help') {
      this.mode = 'help'
      this.render()
    }
  }

  private async handleLessonGesture(gesture: Gesture): Promise<void> {
    if (gesture === 'double') {
      this.goHome()
      return
    }

    const item = this.currentLesson()
    if (!item) {
      this.goHome()
      return
    }

    const maxPage = this.lessonPages(item).length - 1

    if (gesture === 'up') {
      this.lessonPage = Math.max(0, this.lessonPage - 1)
      this.render()
      return
    }

    if (gesture === 'down') {
      this.lessonPage = Math.min(maxPage, this.lessonPage + 1)
      this.render()
      return
    }

    if (this.lessonPage < maxPage) {
      this.lessonPage += 1
      this.render()
      return
    }

    await this.startLessonAssignment()
  }

  private async refreshDashboard(showLoading: boolean): Promise<void> {
    if (!this.token) {
      this.mode = 'setup'
      this.render()
      return
    }

    this.wk = this.wk || new WaniKaniClient(this.token)
    if (showLoading) this.showLoading('Syncing WaniKani', 'Asking the crabigator what you owe it today...')

    try {
      const [user, summary] = await Promise.all([this.wk.getUser(), this.wk.getSummary()])
      const now = Date.now()
      const reviewCount = summary.data.reviews
        .filter(group => Date.parse(group.available_at) <= now)
        .reduce((sum, group) => sum + group.subject_ids.length, 0)
      const lessonCount = summary.data.lessons.reduce((sum, group) => sum + group.subject_ids.length, 0)

      this.dashboard = {
        user,
        reviewCount,
        lessonCount,
        nextReviewsAt: summary.data.next_reviews_at,
        lastSync: new Date().toISOString(),
      }
      this.mode = 'home'
      this.render()
    } catch (error) {
      this.mode = 'setup'
      this.messageTitle = 'Sync failed'
      this.messageBody = shortError(error)
      this.render()
    }
  }

  private async startReviews(): Promise<void> {
    if (!this.requireClient()) return
    this.showLoading('Loading reviews', 'Pulling available review assignments and answer data.')

    try {
      this.reviewQueue = await this.wk!.getStudyItems('reviews', 50)
      this.reviewIndex = 0
      this.correctionItem = null
      this.resetReviewAttempt('Type the meaning on your keyboard, then press Enter.')

      if (this.reviewQueue.length === 0) {
        this.showMessage('No reviews', nextReviewLine(this.dashboard.nextReviewsAt))
        return
      }

      this.mode = 'reviewQuestion'
      this.render()
    } catch (error) {
      this.showMessage('Reviews failed', shortError(error))
    }
  }

  private async startLessons(): Promise<void> {
    if (!this.requireClient()) return
    this.showLoading('Loading lessons', 'Fetching available lessons and subject data.')

    try {
      this.lessonQueue = await this.wk!.getStudyItems('lessons', 25)
      this.lessonIndex = 0
      this.lessonPage = 0

      if (this.lessonQueue.length === 0) {
        this.showMessage('No lessons', 'Nothing unlocked right now. Suspiciously peaceful.')
        return
      }

      this.mode = 'lesson'
      this.render()
    } catch (error) {
      this.showMessage('Lessons failed', shortError(error))
    }
  }

  async submitTypedAnswer(answer: string): Promise<void> {
    if (this.isComposingAnswer) return

    if (this.mode === 'reviewCorrection') {
      this.liveAnswer = ''
      this.setAnswerInput('')
      this.continueAfterCorrection()
      return
    }

    const item = this.currentReview()
    const trimmed = answer.trim()

    if (this.mode !== 'reviewQuestion' || !item) {
      this.liveAnswer = ''
      this.setAnswerInput('')
      this.render()
      return
    }

    if (!trimmed) {
      this.lastAnswerFeedback = 'Type something first. Revolutionary concept, I know.'
      this.render()
      return
    }

    if (this.reviewPart === 'meaning') {
      if (meaningMatches(trimmed, item)) {
        this.liveAnswer = ''
        this.setAnswerInput('')
        if (hasReadingQuestion(item.subject)) {
          this.reviewPart = 'reading'
          this.lastAnswerFeedback = '✓ Meaning correct. Now type the reading.'
          this.render()
          return
        }
        await this.submitCompletedReview()
        return
      }

      this.reviewMeaningWrong += 1
      await this.submitWrongReview('meaning', trimmed)
      return
    }

    if (readingMatches(trimmed, item.subject)) {
      this.liveAnswer = ''
      this.setAnswerInput('')
      await this.submitCompletedReview()
      return
    }

    this.reviewReadingWrong += 1
    await this.submitWrongReview('reading', trimmed)
  }

  updateLiveAnswer(answer: string): void {
    this.liveAnswer = answer
    if (this.mode === 'reviewQuestion') this.render()
  }

  private async submitCompletedReview(): Promise<void> {
    const item = this.currentReview()
    if (!item || !this.wk) return

    this.showLoading('Submitting review', `${displaySubject(item.subject)} → WaniKani`)
    try {
      await this.wk.createReview({
        assignmentId: item.assignment.id,
        incorrectMeaningAnswers: this.reviewMeaningWrong,
        incorrectReadingAnswers: hasReadingQuestion(item.subject) ? this.reviewReadingWrong : 0,
      })

      this.reviewIndex += 1
      this.dashboard.reviewCount = Math.max(0, this.dashboard.reviewCount - 1)

      if (this.reviewIndex >= this.reviewQueue.length) {
        this.liveAnswer = ''
        this.setAnswerInput('')
        this.correctionItem = null
        this.showMessage('Reviews done', 'Submitted. The crabigator has been temporarily appeased.')
        return
      }

      this.resetReviewAttempt('✓ Submitted. Next item: type the meaning.')
      this.mode = 'reviewQuestion'
      this.render()
    } catch (error) {
      this.mode = 'reviewQuestion'
      this.lastAnswerFeedback = `Submit failed: ${shortError(error)}`
      this.render()
    }
  }

  private async submitWrongReview(part: ReviewPart, given: string): Promise<void> {
    const item = this.currentReview()
    if (!item || !this.wk) return

    this.showLoading('Marking wrong', `${displaySubject(item.subject)} → WaniKani`)
    try {
      await this.wk.createReview({
        assignmentId: item.assignment.id,
        incorrectMeaningAnswers: this.reviewMeaningWrong,
        incorrectReadingAnswers: hasReadingQuestion(item.subject) ? this.reviewReadingWrong : 0,
      })

      this.correctionItem = item
      this.correctionPart = part
      this.correctionGiven = given
      this.reviewIndex += 1
      this.dashboard.reviewCount = Math.max(0, this.dashboard.reviewCount - 1)
      this.liveAnswer = ''
      this.setAnswerInput('')
      this.lastAnswerFeedback = `✕ ${part === 'meaning' ? 'Meaning' : 'Reading'} wrong. Correct answer shown. Press Enter or tap the glasses for the next review.`
      this.mode = 'reviewCorrection'
      this.render()
    } catch (error) {
      this.mode = 'reviewQuestion'
      this.liveAnswer = ''
      this.setAnswerInput('')
      this.lastAnswerFeedback = `Submit failed: ${shortError(error)}`
      this.render()
    }
  }

  private continueAfterCorrection(): void {
    this.correctionItem = null
    this.correctionGiven = ''

    if (this.reviewIndex >= this.reviewQueue.length) {
      this.liveAnswer = ''
      this.setAnswerInput('')
      this.showMessage('Reviews done', 'Last wrong answer was submitted. The crabigator has been fed its data pellets.')
      return
    }

    this.resetReviewAttempt('Next item: type the meaning.')
    this.mode = 'reviewQuestion'
    this.render()
  }

  private async startLessonAssignment(): Promise<void> {
    const item = this.currentLesson()
    if (!item || !this.wk) return

    this.showLoading('Starting lesson', `${displaySubject(item.subject)} → WaniKani`)
    try {
      await this.wk.startAssignment(item.assignment.id)
      this.lessonIndex += 1
      this.lessonPage = 0
      this.dashboard.lessonCount = Math.max(0, this.dashboard.lessonCount - 1)

      if (this.lessonIndex >= this.lessonQueue.length) {
        this.showMessage('Lessons done', 'Started all lessons in this batch. Memory palace construction begins, apparently.')
        return
      }

      this.mode = 'lesson'
      this.render()
    } catch (error) {
      this.showMessage('Lesson failed', shortError(error))
    }
  }

  async saveToken(token: string): Promise<void> {
    const clean = token.trim()
    if (!clean) {
      await this.clearToken()
      return
    }

    this.token = clean
    this.wk = new WaniKaniClient(clean)
    await this.store.set(TOKEN_KEY, clean)
    this.updateTokenInput()
    await this.refreshDashboard(true)
  }

  async clearToken(): Promise<void> {
    this.token = ''
    this.wk = null
    this.dashboard = { ...EMPTY_DASHBOARD }
    await this.store.remove(TOKEN_KEY)
    this.updateTokenInput()
    this.mode = 'setup'
    this.render()
  }

  private requireClient(): boolean {
    if (this.wk) return true
    this.mode = 'setup'
    this.render()
    return false
  }

  private currentReview(): StudyItem | null {
    return this.reviewQueue[this.reviewIndex] || null
  }

  private currentLesson(): StudyItem | null {
    return this.lessonQueue[this.lessonIndex] || null
  }

  private goHome(): void {
    this.mode = 'home'
    this.render()
  }

  private showLoading(title: string, body: string): void {
    this.mode = 'loading'
    this.messageTitle = title
    this.messageBody = body
    this.render()
  }

  private showMessage(title: string, body: string): void {
    this.mode = 'message'
    this.messageTitle = title
    this.messageBody = body
    this.render()
  }

  private resetReviewAttempt(feedback = ''): void {
    this.reviewPart = 'meaning'
    this.reviewMeaningWrong = 0
    this.reviewReadingWrong = 0
    this.lastAnswerFeedback = feedback
    this.liveAnswer = ''
    this.isComposingAnswer = false
    this.ignoreNextAnswerSubmit = false
    this.setAnswerInput('')
  }

  private render(): void {
    const model = this.view()
    this.display.render(model)
    this.updateCompanion(model)
  }

  private view(): ViewModel {
    switch (this.mode) {
      case 'setup': return this.setupView()
      case 'home': return this.homeView()
      case 'loading': return this.loadingView()
      case 'message': return this.messageView()
      case 'help': return this.helpView()
      case 'reviewQuestion': return this.reviewQuestionView()
      case 'reviewCorrection': return this.reviewCorrectionView()
      case 'lesson': return this.lessonView()
    }
  }

  private setupView(): ViewModel {
    const error = this.messageTitle === 'Sync failed' ? `\n\nLast error:\n${this.messageBody}` : ''
    return {
      header: 'WaniPocket setup',
      body: `Paste a WaniKani API v2 token in the phone screen.\n\nNeeded: read access, plus write access for reviews and lessons.\n\nThe review keyboard box will autofocus once reviews start.${error}`,
      footer: 'Tap: retry  ·  Double: exit',
    }
  }

  private homeView(): ViewModel {
    const user = this.dashboard.user?.data
    const actions = this.homeActions()
    const menu = actions
      .map((action, index) => `${index === this.homeIndex ? '▶' : ' '} ${action.label}`)
      .join('\n')

    return {
      header: `WaniPocket${user ? ` · ${user.username} L${user.level}` : ''}`,
      body: `${menu}\n\nKeyboard review mode is ready. Start reviews, then type on the phone.\n\nNext review: ${nextReviewLine(this.dashboard.nextReviewsAt)}\nSynced: ${formatTime(this.dashboard.lastSync)}`,
      footer: 'Swipe: move  ·  Tap: select  ·  Double: exit',
    }
  }

  private loadingView(): ViewModel {
    return {
      header: this.messageTitle,
      body: `${this.messageBody}\n\nPlease do not close the app mid-request. We are already begging enough systems to cooperate.`,
      footer: 'Double: back',
    }
  }

  private messageView(): ViewModel {
    return {
      header: this.messageTitle,
      body: this.messageBody,
      footer: 'Tap/Double: home',
    }
  }

  private helpView(): ViewModel {
    return {
      header: 'Controls',
      body: 'Home:\nSwipe = move menu\nTap = select\nDouble = exit\n\nReviews with keyboard:\nType answer on phone\nEnter = grade\nWrong answer = submitted wrong + shows correct answer\nEnter/tap again = next review\nDouble = home\n\nLessons:\nTap = next / start\nSwipe = page prev/next\nDouble = home',
      footer: 'Tap/Double: home',
    }
  }

  private reviewQuestionView(): ViewModel {
    const item = this.currentReview()
    if (!item) return this.messageView()
    const subject = item.subject
    const count = `${this.reviewIndex + 1}/${this.reviewQueue.length}`
    const partLabel = this.reviewPart === 'meaning' ? 'Meaning' : 'Reading'
    const input = this.liveAnswer || '…'
    const wrongs = `Wrong: meaning ${this.reviewMeaningWrong}${hasReadingQuestion(subject) ? ` · reading ${this.reviewReadingWrong}` : ''}`
    const feedback = this.lastAnswerFeedback ? `\n\n${this.lastAnswerFeedback}` : ''

    return {
      header: `Review ${count} · ${partLabel}`,
      body: `${big(displaySubject(subject))}\n${subjectKindLabel(subject)} · Level ${subject.data.level}\n\nQuestion: ${partLabel}\nTyped: ${clip(input, 160)}\n${wrongs}${feedback}`,
      footer: 'Phone keyboard: type + Enter  ·  Double: home',
    }
  }

  private reviewCorrectionView(): ViewModel {
    const item = this.correctionItem
    if (!item) return this.messageView()
    const subject = item.subject
    const answeredPart = this.correctionPart === 'meaning' ? 'Meaning' : 'Reading'
    const meanings = acceptedMeanings(subject, item.studyMaterial).join(', ') || '—'
    const readings = acceptedReadings(subject).join(', ') || '—'
    const readingLine = hasReadingQuestion(subject) ? `
Correct reading:
${clip(readings, 260)}
` : ''
    const nextLine = this.reviewIndex >= this.reviewQueue.length ? 'Press Enter/tap to finish.' : `Press Enter/tap for review ${this.reviewIndex + 1}/${this.reviewQueue.length}.`

    return {
      header: `Marked wrong · ${answeredPart}`,
      body: `${big(displaySubject(subject))}
${subjectKindLabel(subject)} · Level ${subject.data.level}

Your answer:
${clip(this.correctionGiven || '—', 180)}

Correct meaning:
${clip(meanings, 260)}
${readingLine}
${nextLine}`,
      footer: 'Enter/tap: next  ·  Double: home',
    }
  }

  private lessonView(): ViewModel {
    const item = this.currentLesson()
    if (!item) return this.messageView()
    const pages = this.lessonPages(item)
    return {
      header: `Lesson ${this.lessonIndex + 1}/${this.lessonQueue.length} · Page ${this.lessonPage + 1}/${pages.length}`,
      body: pages[this.lessonPage] || '',
      footer: this.lessonPage === pages.length - 1 ? 'Tap: start lesson  ·  Double: home' : 'Tap/Swipe: next  ·  Double: home',
    }
  }

  private homeActions(): Array<{ name: ActionName; label: string }> {
    return [
      { name: 'reviews', label: `Reviews (${this.dashboard.reviewCount})` },
      { name: 'lessons', label: `Lessons (${this.dashboard.lessonCount})` },
      { name: 'refresh', label: 'Refresh now' },
      { name: 'help', label: 'Controls' },
    ]
  }

  private lessonPages(item: StudyItem): string[] {
    const subject = item.subject
    const meanings = acceptedMeanings(subject, item.studyMaterial).join(', ') || '—'
    const readings = acceptedReadings(subject).join(', ') || '—'
    const pos = subject.data.parts_of_speech?.join(', ')
    const meaningMnemonic = stripHtml(subject.data.meaning_mnemonic)
    const readingMnemonic = stripHtml(subject.data.reading_mnemonic)

    const pages = [
      `${big(displaySubject(subject))}\n${subjectKindLabel(subject)} · Level ${subject.data.level}\n\nMeaning:\n${meanings}${pos ? `\n\nPart of speech:\n${pos}` : ''}`,
    ]

    if (hasReadingQuestion(subject)) {
      pages.push(`${big(displaySubject(subject))}\nReading:\n${readings}`)
    }

    pages.push(`Meaning mnemonic:\n${firstUsefulLine(meaningMnemonic, 330) || 'No mnemonic returned.'}`)

    if (readingMnemonic && hasReadingQuestion(subject)) {
      pages.push(`Reading mnemonic:\n${firstUsefulLine(readingMnemonic, 330)}`)
    }

    pages.push(`Ready to start this lesson in WaniKani?\n\n${big(displaySubject(subject))}\n${meanings}\n${readings !== '—' ? readings : ''}\n\nTap to mark the assignment started.`)
    return pages
  }

  private renderCompanionShell(): void {
    const app = document.querySelector<HTMLDivElement>('#app')
    if (!app) return

    app.innerHTML = `
      <main class="shell">
        <section class="hero">
          <div>
            <p class="eyebrow">Even G2 · WaniKani</p>
            <h1>WaniPocket</h1>
            <p class="muted">Use a Bluetooth keyboard connected to your phone for WaniKani reviews. Wrong answers are submitted as wrong, then the correct answer appears before you continue.</p>
          </div>
          <div class="status-pill" id="bridgeStatus">${this.bridge ? 'G2 bridge ready' : 'Browser mode'}</div>
        </section>

        <section class="card answer-card">
          <div class="card-head">
            <div>
              <h2>Review answer</h2>
              <p class="muted small" id="answerHelp">Start reviews, then type here. Enter grades or continues after a wrong answer.</p>
            </div>
            <div class="mode-pill" id="answerMode">Idle</div>
          </div>
          <form id="answerForm" class="answer-row">
            <input id="answerInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Start Reviews, then type answer" />
            <button type="submit">Enter</button>
          </form>
          <p class="feedback" id="answerFeedback"></p>
        </section>

        <section class="card">
          <h2>API token</h2>
          <p class="muted small">Create a WaniKani API v2 token with read access and write access for reviews/assignments. It is stored locally, not sent anywhere except WaniKani.</p>
          <form id="tokenForm" class="token-row">
            <input id="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="Paste WaniKani API v2 token" />
            <button type="submit">Save</button>
          </form>
          <div class="button-row">
            <button id="refreshButton" type="button">Refresh</button>
            <button id="clearButton" type="button" class="secondary">Clear token</button>
          </div>
        </section>

        <section class="grid">
          <div class="card stat"><span>Reviews</span><strong id="reviewsStat">0</strong></div>
          <div class="card stat"><span>Lessons</span><strong id="lessonsStat">0</strong></div>
          <div class="card stat wide"><span>Next review</span><strong id="nextStat">—</strong></div>
        </section>

        <section class="card mirror-card">
          <h2>Glasses mirror</h2>
          <pre id="mirror">Starting...</pre>
        </section>
      </main>
    `

    injectStyles()

    const answerInput = document.querySelector<HTMLInputElement>('#answerInput')

    document.querySelector<HTMLFormElement>('#answerForm')?.addEventListener('submit', event => {
      event.preventDefault()

      if (this.isComposingAnswer || this.ignoreNextAnswerSubmit) {
        this.ignoreNextAnswerSubmit = false
        return
      }

      const value = document.querySelector<HTMLInputElement>('#answerInput')?.value || ''
      this.submitTypedAnswer(value).catch(error => this.showMessage('Answer failed', shortError(error)))
    })

    answerInput?.addEventListener('compositionstart', () => {
      this.isComposingAnswer = true
    })

    answerInput?.addEventListener('compositionend', event => {
      this.isComposingAnswer = false
      this.updateLiveAnswer((event.target as HTMLInputElement).value)

      window.setTimeout(() => {
        this.ignoreNextAnswerSubmit = false
      }, 120)
    })

    answerInput?.addEventListener('input', event => {
      const inputEvent = event as InputEvent
      if (this.isComposingAnswer || inputEvent.isComposing) return
      this.updateLiveAnswer((event.target as HTMLInputElement).value)
    })

    answerInput?.addEventListener('keydown', event => {
  const isImeKey =
    this.isComposingAnswer ||
    event.isComposing ||
    event.key === 'Process' ||
    event.keyCode === 229

  if (event.key === 'Enter' && isImeKey) {
    this.ignoreNextAnswerSubmit = true
  }
})

    document.querySelector<HTMLFormElement>('#tokenForm')?.addEventListener('submit', event => {
      event.preventDefault()
      const value = document.querySelector<HTMLInputElement>('#tokenInput')?.value || ''
      this.saveToken(value).catch(error => this.showMessage('Save failed', shortError(error)))
    })

    document.querySelector<HTMLButtonElement>('#refreshButton')?.addEventListener('click', () => {
      this.refreshDashboard(true).catch(error => this.showMessage('Refresh failed', shortError(error)))
    })

    document.querySelector<HTMLButtonElement>('#clearButton')?.addEventListener('click', () => {
      this.clearToken().catch(error => this.showMessage('Clear failed', shortError(error)))
    })
  }

  private updateCompanion(model: ViewModel): void {
    const mirror = document.querySelector<HTMLPreElement>('#mirror')
    if (mirror) mirror.textContent = `${model.header}\n\n${model.body}\n\n${model.footer}`

    const reviews = document.querySelector<HTMLElement>('#reviewsStat')
    if (reviews) reviews.textContent = String(this.dashboard.reviewCount)

    const lessons = document.querySelector<HTMLElement>('#lessonsStat')
    if (lessons) lessons.textContent = String(this.dashboard.lessonCount)

    const next = document.querySelector<HTMLElement>('#nextStat')
    if (next) next.textContent = nextReviewLine(this.dashboard.nextReviewsAt)

    const answerInput = document.querySelector<HTMLInputElement>('#answerInput')
    const answerMode = document.querySelector<HTMLElement>('#answerMode')
    const answerHelp = document.querySelector<HTMLElement>('#answerHelp')
    const answerFeedback = document.querySelector<HTMLElement>('#answerFeedback')
    const item = this.currentReview()

    if (!this.isComposingAnswer) {
      if (answerInput && document.activeElement !== answerInput && answerInput.value !== this.liveAnswer) {
        answerInput.value = this.liveAnswer
      } else if (answerInput && answerInput.value !== this.liveAnswer && this.mode !== 'reviewQuestion') {
        answerInput.value = this.liveAnswer
      }
    }

    if (answerInput) {
      answerInput.disabled = this.mode !== 'reviewQuestion' && this.mode !== 'reviewCorrection'
      answerInput.readOnly = this.mode === 'reviewCorrection'
      answerInput.placeholder = this.mode === 'reviewQuestion'
        ? `Type ${this.reviewPart}${item ? ` for ${displaySubject(item.subject)}` : ''}`
        : this.mode === 'reviewCorrection'
          ? 'Press Enter for next review'
          : 'Start Reviews, then type answer'
    }

    if (answerMode) answerMode.textContent = this.mode === 'reviewQuestion' ? this.reviewPart.toUpperCase() : this.mode === 'reviewCorrection' ? 'WRONG' : 'Idle'
    if (answerHelp) answerHelp.textContent = this.mode === 'reviewQuestion'
      ? 'Type on the phone keyboard; Enter grades it.'
      : this.mode === 'reviewCorrection'
        ? 'Wrong answer was submitted. Press Enter or tap the glasses to continue.'
        : 'Start reviews from the glasses or Refresh/Home, then type here.'
    if (answerFeedback) answerFeedback.textContent = this.lastAnswerFeedback

    if (
      (this.mode === 'reviewQuestion' || this.mode === 'reviewCorrection') &&
      answerInput &&
      document.activeElement !== answerInput
    ) {
      this.focusAnswerInput()
    }

    if (this.mode === 'setup') this.focusTokenInput()
  }

  private updateTokenInput(): void {
    const input = document.querySelector<HTMLInputElement>('#tokenInput')
    if (input) input.value = this.token
  }

  private setAnswerInput(value: string): void {
    const input = document.querySelector<HTMLInputElement>('#answerInput')
    if (input) input.value = value
  }

  private focusAnswerInput(): void {
    window.setTimeout(() => document.querySelector<HTMLInputElement>('#answerInput')?.focus(), 0)
  }

  private focusTokenInput(): void {
    window.setTimeout(() => document.querySelector<HTMLInputElement>('#tokenInput')?.focus(), 0)
  }

  private cleanup(): void {
    if (!this.unsubscribe) return
    this.unsubscribe()
    this.unsubscribe = null
  }
}

async function main(): Promise<void> {
  const bridge = await waitForBridgeOrNull(3500)
  const display = new G2Display(bridge)
  const app = new WaniPocketApp(bridge, display)
  await app.start()
}

async function waitForBridgeOrNull(timeoutMs: number): Promise<EvenAppBridge | null> {
  try {
    return await Promise.race([
      waitForEvenAppBridge(),
      sleep(timeoutMs).then(() => null),
    ])
  } catch {
    return null
  }
}

function injectStyles(): void {
  if (document.getElementById('wanipocket-styles')) return
  const style = document.createElement('style')
  style.id = 'wanipocket-styles'
  style.textContent = `
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #080b10; color: #eef4ff; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(82, 190, 120, .16), transparent 30rem), #080b10; }
    button, input { font: inherit; }
    .shell { width: min(980px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    .hero { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 18px; }
    .eyebrow { color: #7ee787; text-transform: uppercase; letter-spacing: .12em; font-size: .78rem; margin: 0 0 8px; }
    h1 { font-size: clamp(2.2rem, 8vw, 5rem); line-height: .9; margin: 0 0 12px; }
    h2 { margin: 0 0 10px; }
    .muted { color: #9fb0c9; max-width: 720px; line-height: 1.55; }
    .small { font-size: .95rem; }
    .status-pill, .mode-pill { border: 1px solid rgba(126, 231, 135, .35); border-radius: 999px; padding: 10px 14px; color: #b7ffc0; white-space: nowrap; background: rgba(126, 231, 135, .08); }
    .mode-pill { font-weight: 850; letter-spacing: .08em; font-size: .8rem; }
    .card { background: rgba(14, 20, 31, .86); border: 1px solid rgba(255, 255, 255, .09); border-radius: 24px; padding: 20px; box-shadow: 0 18px 45px rgba(0,0,0,.32); backdrop-filter: blur(14px); margin-top: 16px; }
    .card-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
    .token-row, .answer-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-top: 14px; }
    .answer-card { border-color: rgba(126, 231, 135, .22); }
    input { width: 100%; box-sizing: border-box; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #eef4ff; border-radius: 14px; padding: 13px 14px; outline: none; }
    input:focus { border-color: rgba(126, 231, 135, .8); box-shadow: 0 0 0 4px rgba(126,231,135,.08); }
    input:disabled { opacity: .55; cursor: not-allowed; }
    #answerInput { font-size: 1.2rem; min-height: 54px; }
    button { border: 0; border-radius: 14px; padding: 13px 18px; background: #7ee787; color: #07100a; font-weight: 750; cursor: pointer; }
    button.secondary { background: rgba(255,255,255,.09); color: #eef4ff; border: 1px solid rgba(255,255,255,.12); }
    .button-row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    .feedback { min-height: 1.3em; margin: 12px 0 0; color: #dce8f8; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .stat { margin-top: 16px; min-height: 90px; display: flex; flex-direction: column; justify-content: space-between; }
    .stat span { color: #9fb0c9; }
    .stat strong { font-size: clamp(1.4rem, 4vw, 2.3rem); }
    .wide strong { font-size: clamp(1rem, 2.6vw, 1.45rem); }
    .mirror-card pre { white-space: pre-wrap; min-height: 220px; margin: 0; line-height: 1.45; color: #dce8f8; }
    @media (max-width: 760px) { .hero, .token-row, .answer-row, .card-head { grid-template-columns: 1fr; display: grid; } .grid { grid-template-columns: 1fr; } .status-pill, .mode-pill { width: fit-content; } }
  `
  document.head.appendChild(style)
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function big(text: string): string {
  return `【 ${text} 】`
}

function wrap(index: number, length: number): number {
  if (length <= 0) return 0
  return ((index % length) + length) % length
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function nextReviewLine(iso: string | null): string {
  if (!iso) return 'No reviews scheduled'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  const diffMs = date.getTime() - Date.now()
  if (diffMs <= 0) return 'Now'
  const mins = Math.round(diffMs / 60000)
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const left = mins % 60
  return left ? `${hours}h ${left}m` : `${hours}h`
}

function firstUsefulLine(text: string, maxChars: number): string {
  const collapsed = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n\n')
  return clip(collapsed, maxChars)
}

main().catch(error => {
  console.error(error)
  const app = document.querySelector('#app')
  if (app) app.textContent = `Startup failed: ${shortError(error)}`
})