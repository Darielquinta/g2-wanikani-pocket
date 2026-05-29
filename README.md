# WaniPocket for Even G2

WaniPocket is an Even G2 companion app for WaniKani reviews and lessons.

This version is built for a Bluetooth keyboard connected to your phone:

- Start reviews from the glasses menu.
- The phone companion app autofocuses the **Review answer** text box.
- Whatever you type in that box is mirrored live on the glasses.
- Press **Enter** to grade the current answer.
- Meaning is asked first.
- Reading is asked second when the subject has a reading.
- In reading mode, romaji in the answer box is converted live to hiragana, so `yattsu` becomes `やっつ`.
- Correct answers continue normally: meaning first, then reading when required.
- A genuinely wrong answer is immediately submitted to WaniKani as wrong, then the glasses show the correct meaning/reading.
- If you accidentally type a reading during a meaning prompt, or a meaning during a reading prompt, the app warns you instead of burning the review on a wrong answer type.
- Press **Enter** again or tap the glasses to move to the next review.
- Wrong attempts are sent as `incorrect_meaning_answers` and `incorrect_reading_answers`.

## WaniKani API behavior

WaniKani's public API does **not** expose the exact same answer-checking engine used on the website. The app follows the API contract by doing local answer checks from subject data, then creating a WaniKani review with the official `/reviews` endpoint. Correct answers complete normally. Wrong answers are submitted immediately with the relevant incorrect answer count so you can see the correct answer and move on.

Local checking supports:

- accepted subject meanings
- whitelisted auxiliary meanings
- your WaniKani meaning synonyms from study materials
- kana readings from subject data
- romaji keyboard input converted live to hiragana for readings
- lowercase / punctuation / spacing normalization for meanings

Lessons use WaniKani's assignment start endpoint. The app does **not** submit lesson quiz reviews, because WaniKani says lesson quizzes should not create reviews.

## Setup

Create a WaniKani API v2 token with:

- read access
- write access for reviews / assignments

Then run:

```bash
npm install
npm run dev
```

`npm install` installs the Even Hub SDK dependency used by the app:

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
```

For a browser-only smoke test, use the Vite dev server or run the Even Hub simulator against it:

```bash
npm run simulate
```

Open the app from Even Hub or the simulator, paste the token, and save. If the Codex Cloud/browser environment cannot provide glasses-only bridge APIs, the companion UI continues in browser mode; verify tap/swipe/double-tap gestures and page-container rendering on your Even G2 before publishing.

## Package

```bash
npm run pack
```

That runs a production build and creates:

```text
wanipocket.ehpk
```

## Controls

### Glasses home

- Swipe up/down: move menu
- Tap: select
- Double tap: exit

### Reviews

- Type on phone keyboard
- Enter: grade answer
- Wrong answer: submit wrong + show correct answer
- Enter/tap after correction: next review
- Double tap: home

### Lessons

- Tap: next / start lesson
- Swipe up/down: previous / next page
- Double tap: home

## Notes

The `dist/` folder is intentionally not included in this source zip so you do not accidentally package stale code from a previous build. Run `npm run pack`, because apparently computers still require rituals before obeying.
