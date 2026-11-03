/**
 * Every card tells the presenter how to do the step. In the first real recording the biggest
 * confusion was "do I say it and then click, or click while talking?", so the hint is explicit.
 */
import type { Step } from './storyboard.ts'

export type Lang = 'en' | 'zh'

export type HowKind = 'say-then-click' | 'click' | 'read' | 'read-free' | 'wait' | 'manual'
export type HintKind = 'scroll-down' | 'scroll-up' | 'waiting-page' | 'no-browser' | 'not-found' | 'unsupported' | 'no-permission'

const STRINGS = {
  en: {
    'how.say-then-click': 'Finish the line, then click',
    'how.click': 'Just click, no need to speak',
    'how.read': 'Rest the cursor in the light, then speak. It moves on when the bar fills',
    'how.read-free': 'Start speaking. It moves on when the bar fills',
    'how.wait': 'Wait for it to finish, no need to speak',
    'how.manual': 'Press {nextKey} when you are done',
    'hint.scroll-down': '↓ Scroll down first, speak once the light lands',
    'hint.scroll-up': '↑ Scroll up first, speak once the light lands',
    'hint.waiting-page': 'Waiting for the page…',
    'hint.no-browser': 'Waiting for the browser extension…',
    'hint.not-found': 'Target not found. Press {nextKey} to skip',
    'hint.unsupported': 'This target type is not supported yet. Press {nextKey} to skip',
    'hint.no-permission': 'Allow Cuelight in System Settings, Privacy & Security first. Press {nextKey} to skip',
    'tag.click': 'Click',
    'tag.read': 'Say this',
    'tag.wait': 'Wait',
    'tag.manual': 'Talk',
    next: 'Next: ',
    'preroll.say': 'Ready. Start your recorder, then press {nextKey}',
    'preroll.tag': '{title} · {n} steps',
    'done.say': 'That was the last step. You can stop recording.',
    'done.tag': 'Done',
    'done.how': 'Press {nextKey} to close the prompter',
    capturable: 'Visible to capture (debug)',
  },
  zh: {
    'how.say-then-click': '先说完这句，再点',
    'how.click': '直接点，不用说话',
    'how.read': '光标停进灯里再开口，进度条走完自动翻页',
    'how.read-free': '开口说，进度条走完自动翻页',
    'how.wait': '等它跑完，不用说话',
    'how.manual': '说完按 {nextKey} 翻页',
    'hint.scroll-down': '↓ 先往下滚，灯到位了再开口',
    'hint.scroll-up': '↑ 先往上滚，灯到位了再开口',
    'hint.waiting-page': '等页面出来…',
    'hint.no-browser': '等浏览器扩展连上…',
    'hint.not-found': '找不到目标，按 {nextKey} 跳过',
    'hint.unsupported': '暂不支持这种定位，按 {nextKey} 跳过',
    'hint.no-permission': '先在系统设置的隐私与安全性里允许 Cuelight，按 {nextKey} 跳过',
    'tag.click': '点击',
    'tag.read': '读这句',
    'tag.wait': '等待',
    'tag.manual': '口播',
    next: '下一句：',
    'preroll.say': '准备好了：先开始录屏，再按 {nextKey}',
    'preroll.tag': '{title} · 共 {n} 步',
    'done.say': '最后一步走完了，可以停止录屏。',
    'done.tag': '结束',
    'done.how': '按 {nextKey} 关闭提词器',
    capturable: '可被截屏（调试）',
  },
} as const

export type CueKey = keyof (typeof STRINGS)['en']

/** Hotkey labels shown on cards. Windows and Linux use Ctrl+Alt instead of ⌥⌘. */
export const keyLabels = (platform: string = 'darwin') =>
  platform === 'darwin'
    ? { nextKey: '⌥⌘→', prevKey: '⌥⌘←', hideKey: '⌥⌘H' }
    : { nextKey: 'Ctrl+Alt+→', prevKey: 'Ctrl+Alt+←', hideKey: 'Ctrl+Alt+H' }

let platformKeys = keyLabels()
export const setCuePlatform = (platform: string) => {
  platformKeys = keyLabels(platform)
}

export function cue(lang: Lang, key: CueKey, vars: Record<string, string | number> = {}): string {
  const s: string = STRINGS[lang][key] ?? STRINGS.en[key]
  const all: Record<string, string | number> = { ...platformKeys, ...vars }
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(all[k] ?? ''))
}

export function howKind(step: Pick<Step, 'act' | 'say' | 'target'>): HowKind {
  switch (step.act) {
    case 'wait':
      return 'wait'
    case 'manual':
      return 'manual'
    case 'read':
      return step.target ? 'read' : 'read-free'
    case 'click':
      return step.say ? 'say-then-click' : 'click'
  }
}

/** An author's own hint may name the hotkeys as {nextKey}, {prevKey} and {hideKey}. */
export function howTo(step: Pick<Step, 'act' | 'say' | 'target' | 'how'>, lang: Lang): string {
  return step.how !== undefined ? step.how.replace(/\{(nextKey|prevKey|hideKey)\}/g, (_, k: keyof typeof platformKeys) => platformKeys[k]) : cue(lang, `how.${howKind(step)}`)
}

export function defaultTag(step: Pick<Step, 'act' | 'tag'>, lang: Lang): string {
  return step.tag ?? cue(lang, `tag.${step.act}`)
}

/** Pick a UI language from a locale string such as "zh-CN" or "en-GB". */
export const langFromLocale = (locale: string | undefined): Lang => (locale && /^zh/i.test(locale) ? 'zh' : 'en')
