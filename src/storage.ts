import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export const TOKEN_KEY = 'wanipocket.wkToken.v1'
export const SUBJECT_CACHE_KEY = 'wanipocket.subjectCache.v1'
export const STARRED_SUBJECTS_KEY = 'wanipocket.starredSubjects.v1'

export class PersistStore {
  constructor(private bridge: EvenAppBridge | null) {}

  async get(key: string): Promise<string> {
    const bridgeValue = await this.getFromBridge(key)
    if (bridgeValue) return bridgeValue
    return this.getFromBrowser(key)
  }

  async set(key: string, value: string): Promise<void> {
    await Promise.allSettled([
      this.setInBridge(key, value),
      Promise.resolve().then(() => window.localStorage.setItem(key, value)),
    ])
  }

  async remove(key: string): Promise<void> {
    await Promise.allSettled([
      this.setInBridge(key, ''),
      Promise.resolve().then(() => window.localStorage.removeItem(key)),
    ])
  }

  private async getFromBridge(key: string): Promise<string> {
    if (!this.bridge) return ''
    try {
      return (await this.bridge.getLocalStorage(key)) || ''
    } catch {
      return ''
    }
  }

  private getFromBrowser(key: string): string {
    try {
      return window.localStorage.getItem(key) || ''
    } catch {
      return ''
    }
  }

  private async setInBridge(key: string, value: string): Promise<void> {
    if (!this.bridge) return
    try {
      await this.bridge.setLocalStorage(key, value)
    } catch {
      // Browser localStorage fallback still runs. Humans demanded persistence, so we use belts and suspenders.
    }
  }
}

export function loadSubjectCache<T>(): Record<string, T> {
  try {
    const raw = window.localStorage.getItem(SUBJECT_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, T>
  } catch {
    return {}
  }
}

export function saveSubjectCache<T>(cache: Record<string, T>): void {
  try {
    window.localStorage.setItem(SUBJECT_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Cache misses are annoying, not fatal. Like most app problems.
  }
}
