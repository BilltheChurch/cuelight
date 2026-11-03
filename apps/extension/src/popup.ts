import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, EyeOff, KeyRound, LoaderCircle, Play, Plug, Square, Unlink, createElement, type IconNode } from 'lucide'
import type { FromPopup, PopupState } from './messages.ts'

const zh = /^zh/i.test(navigator.language)
const T = zh
  ? {
      connected: '已连上 Cuelight',
      connecting: '正在连接 Cuelight…',
      offline: '没找到 Cuelight 应用',
      offlineHint: '先打开桌面上的 Cuelight，这里会自动连上。',
      unpaired: '和 Cuelight 配对',
      unpairedHint: '在 Cuelight 应用里找到 6 位配对码，填在下面。只需配一次。',
      denied: '配对码不对',
      locked: '试错太多次，请在应用里换一个新码',
      pair: '配对',
      idle: '还没开始播放分镜',
      play: '开始播放',
      noStoryboard: '先在 Cuelight 应用里选一份分镜',
      prev: '上一步',
      next: '下一步',
      hide: '隐藏',
      stop: '停止',
      unpair: '解除配对',
      step: '第 {n} / {total} 步',
    }
  : {
      connected: 'Connected to Cuelight',
      connecting: 'Connecting to Cuelight…',
      offline: 'Cuelight app not found',
      offlineHint: 'Open Cuelight on your desktop and this connects by itself.',
      unpaired: 'Pair with Cuelight',
      unpairedHint: 'Enter the 6-digit code shown in the Cuelight app. You only do this once.',
      denied: 'That code did not match',
      locked: 'Too many tries. Get a fresh code in the app',
      pair: 'Pair',
      idle: 'No storyboard playing',
      play: 'Play',
      noStoryboard: 'Pick a storyboard in the Cuelight app first',
      prev: 'Back',
      next: 'Next',
      hide: 'Hide',
      stop: 'Stop',
      unpair: 'Unpair',
      step: 'Step {n} of {total}',
    }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const icon = (node: IconNode, size = 18) => createElement(node, { width: size, height: size, 'stroke-width': 2 })
const ask = (m: FromPopup) => chrome.runtime.sendMessage(m) as Promise<PopupState>

function setIcon(el: HTMLElement, node: IconNode, size?: number) {
  el.replaceChildren(icon(node, size))
}

function render(s: PopupState) {
  const head = $('status')
  const title = $('status-title')
  const hint = $('status-hint')
  const pair = $('pair')
  const show = $('show')
  head.dataset.state = s.status
  pair.hidden = !(s.status === 'unpaired' || s.status === 'denied')
  show.hidden = s.status !== 'connected'
  $('unpair').hidden = s.status !== 'connected'
  hint.textContent = ''
  switch (s.status) {
    case 'connected':
      setIcon($('status-icon'), CircleCheck)
      title.textContent = T.connected
      hint.textContent = [s.app, s.port ? `127.0.0.1:${s.port}` : ''].filter(Boolean).join(' · ')
      break
    case 'connecting':
      setIcon($('status-icon'), LoaderCircle)
      title.textContent = T.connecting
      break
    case 'offline':
      setIcon($('status-icon'), Plug)
      title.textContent = T.offline
      hint.textContent = T.offlineHint
      break
    case 'unpaired':
      setIcon($('status-icon'), KeyRound)
      title.textContent = T.unpaired
      hint.textContent = T.unpairedHint
      break
    case 'denied':
      setIcon($('status-icon'), CircleAlert)
      title.textContent = s.error === 'locked' ? T.locked : T.denied
      hint.textContent = T.unpairedHint
      break
  }
  const sh = s.show
  const playing = !!sh?.playing
  $('show-title').textContent = sh?.title || T.idle
  $('show-step').textContent = playing ? T.step.replace('{n}', String(sh!.n)).replace('{total}', String(sh!.total)) : sh?.loaded ? '' : T.noStoryboard
  $('play').hidden = playing || !sh?.loaded
  $('transport').hidden = !playing
  $('row').hidden = !playing
}

function init() {
  document.documentElement.lang = zh ? 'zh-CN' : 'en'
  setIcon($('play-icon'), Play)
  $('play-label').textContent = T.play
  setIcon($('prev-icon'), ChevronLeft)
  setIcon($('next-icon'), ChevronRight)
  setIcon($('hide-icon'), EyeOff, 16)
  setIcon($('stop-icon'), Square, 16)
  setIcon($('unpair-icon'), Unlink, 14)
  $('pair-btn').textContent = T.pair
  $('prev-label').textContent = T.prev
  $('next-label').textContent = T.next
  $('hide-label').textContent = T.hide
  $('stop-label').textContent = T.stop
  $('unpair-label').textContent = T.unpair

  const code = $<HTMLInputElement>('code')
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6)
    ;($('pair-btn') as HTMLButtonElement).disabled = code.value.length !== 6
  })
  $('pair-form').addEventListener('submit', (e) => {
    e.preventDefault()
    if (code.value.length === 6) void ask({ t: 'pair', code: code.value }).then(render)
  })
  for (const cmd of ['play', 'prev', 'next', 'hide', 'stop'] as const) $(cmd).addEventListener('click', () => void ask({ t: 'control', cmd }).then(render))
  $('unpair').addEventListener('click', () => void ask({ t: 'unpair' }).then(render))

  chrome.runtime.onMessage.addListener((m: { t: string; state?: PopupState }) => {
    if (m.t === 'popup-state' && m.state) render(m.state)
  })
  void ask({ t: 'state' }).then(render)
}

init()
