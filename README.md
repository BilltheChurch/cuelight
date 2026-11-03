# Cuelight

A teleprompter pinned to your UI. While you record a product demo or present live, Cuelight dims the screen around the next thing to click, puts your line right next to it, and tells you whether to talk first or click first. Screen recorders and meeting screen-share do not see any of it.

You still do the clicking and the talking. Cuelight is a prompter for the person on camera, not a robot that records the demo for you.

> Status: early development (M1). The desktop overlay, the capture self-test, the browser extension and storyboard playback work on macOS. The editor, path recording and AI drafting are next. Nothing is packaged or signed yet.

## How it's different

- **Cues pinned to the UI.** Your line sits next to the element you click next, and a real click moves the show forward. Prompters scroll on a timer or follow your voice; they do not know what is on screen.
- **It tells you how to deliver each step.** "Finish the line, then click", "Just click, no need to talk", "Rest the cursor in the light and start talking". A read bar fills while you speak, and the next line is previewed on the card.
- **Works with whatever records you.** Cuelight does not record. Use Screen Studio, OBS, QuickTime, Loom or a meeting share; the overlay is excluded from capture at the window-system level. Run the built-in self-test to check it on your machine.
- **Runs in your own browser.** The extension lives in your everyday, logged-in Chrome or Edge (other Chromium browsers should work but are untested), so sign-ins, bot checks and localhost dev servers just work. No automated browser, no webdriver flag.
- **Beyond the web (planned).** The same storyboard can target desktop apps through the macOS accessibility tree, on-screen text found by OCR, fixed screen regions, or no target at all for talking-head segments.
- **Bring your own AI (planned).** Record a path once and let your own endpoint (Anthropic, OpenAI, any OpenAI-compatible URL, or a local model) draft and tighten the script. Keys stay in the OS keychain.
- **MIT licensed.**

## How it works

```
 Chrome / Edge (Chromium)                    Cuelight desktop app
┌─────────────────────────────┐   ws://127.0.0.1   ┌──────────────────────────────┐
│ extension                   │ ◀───────────────▶ │ player: steps, timing, keys  │
│  finds the element, reports │   pairing code    │ overlay: one transparent,    │
│  its rect, sees your clicks │   then a token    │  click-through window per    │
└─────────────────────────────┘                   │  display, content-protected  │
                                                  └──────────────────────────────┘
```

- The desktop app (Electron) owns the overlay windows: transparent, click-through, always on top, one per display, with `setContentProtection(true)` (`NSWindowSharingNone` on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows 10 2004 and later).
- The extension (Manifest V3) resolves each step's target in the page, reports where it is on screen as you scroll, zoom or resize, and tells the app when you click it.
- They talk over a WebSocket bound to 127.0.0.1 only. The first connection needs the 6-digit code shown in the app; after that the extension keeps a token.

## Repository layout

| Path | What it is |
|---|---|
| `apps/desktop` | Electron + Vite + React app: overlay, player, hotkeys, local bridge, self-test |
| `apps/extension` | Chromium MV3 extension: element locator, rect reporting, click detection, popup |
| `packages/schema` | Storyboard schema (zod + generated JSON Schema), pacing, cue strings, wire protocol, geometry |
| `examples` | Storyboards you can play right away |
| `scripts/e2e-web.mjs` | End-to-end check that drives a throwaway Chromium profile through an example |

## Getting started

Requirements: macOS (Windows should mostly work but is untested), Node 22.12 or newer, pnpm 11.

```bash
pnpm install
```

`pnpm install` fetches the Electron binary through the desktop package's `postinstall`. If your default registry is a mirror that is unreachable, add `--registry=https://registry.npmjs.org/`.

Build the extension and start the app:

```bash
pnpm --filter @cuelight/extension build
```

```bash
pnpm dev
```

Load the extension in your browser:

1. Open `chrome://extensions` (or `edge://extensions`) and turn on Developer mode.
2. Click Load unpacked and pick `apps/extension/dist`.
3. Click the Cuelight icon in the toolbar and type the 6-digit code shown in the app's Browser tile. You only pair once.

Then pick an example in the app (TodoMVC is a good first one) and press Play. When you start from step 1, the browser tab you used last goes to the storyboard's start page, and a short preroll card waits for ⌥⌘→ before the first step.

## Playing a storyboard

| Keys (macOS) | Keys (Windows, Linux) | Action |
|---|---|---|
| ⌥⌘→ | Ctrl+Alt+→ | Next step |
| ⌥⌘← | Ctrl+Alt+← | Previous step |
| ⌥⌘H | Ctrl+Alt+H | Hide or show the overlay |

The hotkeys are only registered while a storyboard is playing. If your recorder shows keystrokes on screen, turn that off, or your audience will see every ⌥⌘→.

What you see on each step:

- **click**: the light sits on the element. Say the line, then click it. The step advances on the click.
- **read**: rest the cursor inside the light and talk. The read bar only fills while the cursor is in the light, and the step advances when it is full.
- **wait**: do what the card says (type something, wait for a page to load). The step advances when the `until` condition is met.
- **manual**: talk, then press ⌥⌘→.

If the element is above or below the visible part of the page, the light collapses into a strip at that edge with a scroll hint, and moves onto the element once you scroll it into view. If the page has not loaded yet, or the element cannot be found, the card says so.

Read time is estimated at about two English words per second (a CJK character counts as half a word), plus 1.2 seconds, and never less than 2.5 seconds. A storyboard can change this under `pace`.

## Storyboard format

A storyboard is a JSON file. The full schema is in [`packages/schema/storyboard.schema.json`](packages/schema/storyboard.schema.json), generated from [`packages/schema/src/storyboard.ts`](packages/schema/src/storyboard.ts).

```json
{
  "$schema": "../packages/schema/storyboard.schema.json",
  "cuelight": 1,
  "title": "TodoMVC quick tour",
  "language": "en",
  "start": { "url": "https://demo.playwright.dev/todomvc/#/" },
  "steps": [
    {
      "act": "click",
      "say": "Let's add a task.",
      "target": [
        { "kind": "dom", "role": "textbox", "name": "What needs to be done?" },
        { "kind": "dom", "css": "input.new-todo" }
      ]
    },
    {
      "act": "wait",
      "how": "Type “Rehearse the demo” and press Enter",
      "until": { "appear": [{ "kind": "dom", "testId": "todo-title", "text": { "exact": "Rehearse the demo" } }] }
    }
  ]
}
```

Each step has an `act` (`click`, `read`, `wait`, `manual`), the line to `say`, and an optional `target`. A target is a list of locators tried in order, so you can give a precise one first and a looser fallback after it. Locator kinds:

| `kind` | Finds | Status |
|---|---|---|
| `dom` | A web element by test id, ARIA role and accessible name, visible text, or CSS, optionally scoped `within` another element and limited to a `url` glob | Works |
| `region` | A fixed rectangle relative to the screen or a window, in points or fractions | Screen-relative works; window-relative is planned |
| `ax` | A desktop app element through the macOS accessibility tree (bundle id, window, role, title, identifier, path) | Planned (M5) |
| `visual` | Text or an image found on screen by OCR or template matching | Planned (M5) |
| none | No `target`: the card sits at the top or bottom of the screen, for talking-head parts | Works |

Text matches can be a substring (`"Save"`), exact (`{ "exact": "Save" }`), or a regular expression (`{ "re": "^Save( all)?$", "flags": "i" }`).

## The capture self-test

Capture exclusion depends on the OS and on which capture API a recorder uses, so check it on your own machine. In the app, open the Capture tile and run the self-test, or from the command line:

```bash
pnpm selftest
```

It draws a test pattern on every display, takes screenshots with the overlay made capturable and then protected again, and compares the pixels. It passes when the pattern shows up in the first grab and is gone from the second.

Tested so far:

| OS | Capture path | Result |
|---|---|---|
| macOS 27.0.1, Electron 45.2 | `screencapture` (the system screenshot tool) | Hidden |
| macOS 27.0.1, Electron 45.2 | Chromium `desktopCapturer` (what Electron and Chrome screen-share use) | Hidden |

Electron's documentation warns that on recent macOS versions some apps built on ScreenCaptureKit ignore content protection. Before relying on it for a particular recorder or meeting app, make a short test recording with that app. A recorder matrix (Zoom, Teams, Meet, QuickTime, OBS, Screen Studio, Loom, Cap) is on the roadmap.

## Development

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm build
```

The end-to-end check plays an example against its public site in a throwaway browser profile, pairs through the real popup, performs every step with trusted input, and checks that the spotlight is within 3 points of where the browser itself places the element on screen. Point it at Chromium or Chrome for Testing with `CHROMIUM`, or at branded Chrome or Edge with `CHROME` (those ignore `--load-extension` since version 137, so the script installs the extension through the DevTools protocol instead):

```bash
pnpm build && CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/e2e-web.mjs todomvc --zoom 1.25
```

Set `E2E_PROXY=http://127.0.0.1:port` if the browser needs a proxy to reach the site. Add `--shots <dir>` to save a screenshot of the test window per step with the overlay made capturable.

So far it passes on macOS 27 for both examples in Google Chrome 156, Microsoft Edge 156 and Chrome for Testing 153, and at 125% page zoom in Chrome and Chrome for Testing.

Command-line flags for the app, useful while developing: `--open <storyboard.json>`, `--play [--from <n>]`, `--selftest [--selftest-out <dir>]`, and `--log` (prints events as `CUELIGHT {json}` lines on stdout).

## Roadmap

- **M2**: editor (step list, step details, pick elements on the page, rehearse a single step).
- **M3**: record a path in the browser and turn it into a draft storyboard.
- **M4**: AI drafting and rewriting through your own endpoint, with structured output, validation and a diff to accept or reject.
- **M5**: desktop apps (macOS accessibility tree, global click detection, OCR anchors, window regions).
- **M6**: rehearsal timing, exports (voice-over script, SRT, chapters), signed and notarised builds, store listing.

## A note on use

Cuelight is a prompter for your own talk. The overlay hides from capture so your recording looks clean, not so anyone can be misled about what you are reading. Some workplaces and exam tools detect or block capture-excluded windows.

## License

[MIT](LICENSE)
