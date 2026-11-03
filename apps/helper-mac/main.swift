// Cuelight's native helper for macOS. The desktop app starts it and talks to it in JSON lines:
// requests {"id":1,"cmd":"...",...} on stdin, replies {"id":1,"ok":true,...} on stdout, and
// unasked events {"ev":"click",...} on stdout too. It reads the Accessibility tree, finds text
// on screen with on-device OCR, lists windows, and watches clicks (or, while picking, takes one).
// Matching locators against what it reports is the app's job, in TypeScript.
//
// Nothing here asks for a permission unless told to with the "ask" command.

import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

let version = "0.1.0"
let out = DispatchQueue(label: "out")

func send(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
  out.async {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }
}

func reply(_ id: Any?, _ fields: [String: Any]) {
  var o = fields
  o["id"] = id ?? NSNull()
  if o["ok"] == nil { o["ok"] = true }
  send(o)
}

func fail(_ id: Any?, _ error: String) { reply(id, ["ok": false, "error": error]) }

/// The app that started us, so a click on its own windows cancels a pick instead of picking.
let ownerPid: pid_t = {
  let args = CommandLine.arguments
  if let i = args.firstIndex(of: "--owner-pid"), i + 1 < args.count, let p = Int32(args[i + 1]) { return p }
  return getppid()
}()

func rectArray(_ r: CGRect) -> [Double] { [Double(r.minX), Double(r.minY), Double(r.width), Double(r.height)] }

func bundleId(_ pid: pid_t) -> String { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "" }

// ---------------------------------------------------------------- windows

/// On-screen windows front to back, in global points with the origin at the top left of the
/// main display (the same space Electron's screen API uses). Titles need Screen Recording.
func windows(app: String?) -> [[String: Any]] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  var res: [[String: Any]] = []
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? pid_t,
      let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b)
    else { continue }
    let bid = bundleId(pid)
    if let app = app, app != bid { continue }
    res.append(["app": bid, "pid": pid, "title": w[kCGWindowName as String] as? String ?? "", "rect": rectArray(r)])
  }
  return res
}

// ---------------------------------------------------------------- Accessibility

let fields = [
  kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXIdentifier", kAXValueAttribute,
  kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
] as CFArray

/// Elements from the latest walks, so the app can poll one element's frame cheaply by its ref.
var refs: [Int: AXUIElement] = [:]
var nextRef = 1

func remember(_ el: AXUIElement) -> Int {
  let r = nextRef
  nextRef += 1
  refs[r] = el
  if refs.count > 20000 { refs = refs.filter { $0.key > r - 10000 } }
  return r
}

func isError(_ v: AnyObject) -> Bool { CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError }

func string(_ v: AnyObject?) -> String? {
  guard let v = v, !isError(v) else { return nil }
  if let s = v as? String { return s }
  return nil
}

func frameOf(position: AnyObject?, size: AnyObject?) -> [Double]? {
  guard let p = position, let s = size, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID(), !isError(p), !isError(s) else {
    return nil
  }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
  return rectArray(CGRect(origin: pt, size: sz))
}

func element(_ v: AnyObject?) -> AXUIElement? {
  guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func frame(_ el: AXUIElement) -> [Double]? { frameOf(position: attr(el, kAXPositionAttribute), size: attr(el, kAXSizeAttribute)) }

/// One element's own fields, and its children to walk.
func describe(_ el: AXUIElement) -> ([String: Any], [AXUIElement]) {
  var values: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(el, fields, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
    let v = values as [AnyObject]?, v.count == 9
  else { return ([:], []) }
  var node: [String: Any] = ["role": string(v[0]) ?? ""]
  if let s = string(v[1]), !s.isEmpty { node["subrole"] = s }
  if let s = string(v[2]), !s.isEmpty { node["title"] = s }
  if let s = string(v[3]), !s.isEmpty { node["description"] = s }
  if let s = string(v[4]), !s.isEmpty { node["identifier"] = s }
  if let s = string(v[5]), !s.isEmpty, s.count <= 120 { node["value"] = s }
  if let f = frameOf(position: v[6], size: v[7]) { node["rect"] = f }
  let kids = (isError(v[8]) ? nil : v[8] as? [AXUIElement]) ?? []
  return (node, kids)
}

func appElement(_ bundle: String) -> (AXUIElement, pid_t)? {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { return nil }
  let el = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(el, 0.5)
  return (el, app.processIdentifier)
}

/// The app's windows and everything in them, flattened: each node knows its parent and window.
func tree(app: String, maxNodes: Int, maxDepth: Int) -> [String: Any]? {
  guard let (appEl, _) = appElement(app) else { return nil }
  let wins = (attr(appEl, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var nodes: [[String: Any]] = []
  for (wi, w) in wins.enumerated() {
    var stack: [(AXUIElement, Int, Int)] = [(w, -1, 0)]
    while let (el, parent, depth) = stack.popLast(), nodes.count < maxNodes {
      var (node, kids) = describe(el)
      node["parent"] = parent
      node["depth"] = depth
      node["window"] = wi
      node["ref"] = remember(el)
      let me = nodes.count
      nodes.append(node)
      if depth < maxDepth { for k in kids.reversed() { stack.append((k, me, depth + 1)) } }
    }
  }
  // Children were pushed in reverse, so each parent's children come out in their own order.
  return ["nodes": nodes, "truncated": nodes.count >= maxNodes]
}

/// The element under a point, with its ancestors up to the window, for picking.
func hit(x: Double, y: Double) -> [String: Any]? {
  let sys = AXUIElementCreateSystemWide()
  var found: AXUIElement?
  guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &found) == .success, let el = found else { return nil }
  var pid: pid_t = 0
  AXUIElementGetPid(el, &pid)
  var chain: [[String: Any]] = []
  var cur: AXUIElement? = el
  while let c = cur, chain.count < 40 {
    var (node, _) = describe(c)
    node["ref"] = remember(c)
    chain.append(node)
    if (node["role"] as? String) == kAXWindowRole { break }
    cur = element(attr(c, kAXParentAttribute))
  }
  return ["app": bundleId(pid), "pid": pid, "own": pid == ownerPid, "chain": chain]
}

// ---------------------------------------------------------------- clicks

/// Watching clicks only listens, so a slow reply never holds up the mouse. Picking takes the
/// click (the element under it must not react) and Esc, so it filters, for one click only.
enum TapMode { case none, listen, take }

var tap: CFMachPort?
var tapSource: CFRunLoopSource?
var tapMode = TapMode.none
var watchClicks = false
var picking = false
var swallowUp = false

/// Whether the front window under a point belongs to the app that started us.
func ownWindowAt(_ p: CGPoint) -> Bool {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0, let b = w[kCGWindowBounds as String] as? NSDictionary,
      let r = CGRect(dictionaryRepresentation: b), r.contains(p)
    else { continue }
    return (w[kCGWindowOwnerPID as String] as? pid_t) == ownerPid
  }
  return false
}

let escapeKey: Int64 = 53

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  let p = event.location
  switch type {
  case .leftMouseDown where picking:
    picking = false
    if ownWindowAt(p) {
      send(["ev": "pick-cancel"])
      DispatchQueue.main.async { _ = updateTap() }
      return Unmanaged.passUnretained(event)
    }
    swallowUp = true
    send(["ev": "pick", "x": Double(p.x), "y": Double(p.y)])
    return nil
  case .leftMouseDown:
    if watchClicks { send(["ev": "click", "x": Double(p.x), "y": Double(p.y)]) }
  case .leftMouseUp where swallowUp:
    swallowUp = false
    DispatchQueue.main.async { _ = updateTap() }
    return nil
  case .keyDown where picking && event.getIntegerValueField(.keyboardEventKeycode) == escapeKey:
    picking = false
    send(["ev": "pick-cancel"])
    DispatchQueue.main.async { _ = updateTap() }
    return nil
  default:
    break
  }
  return Unmanaged.passUnretained(event)
}

func dropTap() {
  if let t = tap {
    CGEvent.tapEnable(tap: t, enable: false)
    if let s = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
    CFMachPortInvalidate(t)
  }
  tap = nil
  tapSource = nil
  tapMode = .none
}

/// Puts up the tap the current state needs, if any. Both kinds need Accessibility.
func updateTap() -> Bool {
  let want: TapMode = picking || swallowUp ? .take : watchClicks ? .listen : .none
  if want == tapMode { return true }
  dropTap()
  if want == .none { return true }
  var mask = (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.leftMouseUp.rawValue)
  if want == .take { mask |= 1 << CGEventType.keyDown.rawValue }
  guard
    let t = CGEvent.tapCreate(
      tap: .cgSessionEventTap, place: .headInsertEventTap, options: want == .take ? .defaultTap : .listenOnly,
      eventsOfInterest: CGEventMask(mask), callback: tapCallback, userInfo: nil)
  else { return false }
  tap = t
  tapSource = CFMachPortCreateRunLoopSource(nil, t, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
  CGEvent.tapEnable(tap: t, enable: true)
  tapMode = want
  return true
}

// ---------------------------------------------------------------- OCR

/// Lines of text in an image, with boxes in the image's own top-left space scaled to `into`.
/// With `find`, each line containing it (any case) also gets the box of that part alone.
func recognize(_ image: CGImage, into: CGRect, find: String?) throws -> [[String: Any]] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  req.automaticallyDetectsLanguage = true
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
  let box = { (bb: CGRect) -> [Double] in
    rectArray(CGRect(x: into.minX + bb.minX * into.width, y: into.minY + (1 - bb.maxY) * into.height, width: bb.width * into.width, height: bb.height * into.height))
  }
  var lines: [[String: Any]] = []
  for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    var line: [String: Any] = ["text": c.string, "rect": box(o.boundingBox), "confidence": Double(c.confidence)]
    if let f = find, !f.isEmpty, let r = c.string.range(of: f, options: [.caseInsensitive, .diacriticInsensitive]),
      let sub = try? c.boundingBox(for: r)
    {
      line["sub"] = box(sub.boundingBox)
    }
    lines.append(line)
  }
  return lines
}

/// A picture of part of the screen, without Cuelight's own windows. Needs Screen Recording.
func capture(_ rect: CGRect) async throws -> (CGImage, CGRect) {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  let mid = CGPoint(x: rect.midX, y: rect.midY)
  guard let display = content.displays.first(where: { $0.frame.contains(mid) }) ?? content.displays.first else {
    throw NSError(domain: "cuelight", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])
  }
  let r = rect.intersection(display.frame)
  let config = SCStreamConfiguration()
  let scale = Double(NSScreen.screens.first { $0.frame.width == display.frame.width }?.backingScaleFactor ?? 2)
  config.sourceRect = CGRect(x: r.minX - display.frame.minX, y: r.minY - display.frame.minY, width: r.width, height: r.height)
  config.width = Int(r.width * scale)
  config.height = Int(r.height * scale)
  config.showsCursor = false
  // Our own windows stay out of the picture even when the overlay is left capturable for debugging.
  let own = content.applications.filter { $0.processID == ownerPid }
  let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  return (image, r)
}

// ---------------------------------------------------------------- commands

func handle(_ c: [String: Any]) {
  let id = c["id"]
  let num = { (k: String) -> Double? in (c[k] as? NSNumber)?.doubleValue }
  switch c["cmd"] as? String ?? "" {
  case "status":
    reply(id, ["version": version, "trusted": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()])
  case "ask":
    // Shows the system's own prompt, once; afterwards the setting lives in System Settings.
    if c["what"] as? String == "screen" {
      reply(id, ["granted": CGRequestScreenCaptureAccess()])
    } else {
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      reply(id, ["granted": AXIsProcessTrustedWithOptions(opts)])
    }
  case "windows":
    reply(id, ["windows": windows(app: c["app"] as? String)])
  case "ax.tree":
    guard AXIsProcessTrusted() else { return fail(id, "not-trusted") }
    guard let app = c["app"] as? String, let t = tree(app: app, maxNodes: Int(num("max") ?? 4000), maxDepth: Int(num("depth") ?? 40)) else {
      return fail(id, "no-app")
    }
    reply(id, t)
  case "ax.frame":
    guard let r = num("ref"), let el = refs[Int(r)] else { return fail(id, "gone") }
    guard let f = frame(el) else { return fail(id, "gone") }
    reply(id, ["rect": f])
  case "ax.hit":
    guard AXIsProcessTrusted() else { return fail(id, "not-trusted") }
    guard let x = num("x"), let y = num("y"), let h = hit(x: x, y: y) else { return fail(id, "nothing") }
    reply(id, h)
  case "clicks":
    watchClicks = c["on"] as? Bool ?? false
    if updateTap() { return reply(id, [:]) }
    watchClicks = false
    fail(id, "not-trusted")
  case "pick":
    picking = c["on"] as? Bool ?? false
    if updateTap() { return reply(id, [:]) }
    picking = false
    fail(id, "not-trusted")
  case "ocr":
    guard let r = c["rect"] as? [NSNumber], r.count == 4 else { return fail(id, "bad-rect") }
    let rect = CGRect(x: r[0].doubleValue, y: r[1].doubleValue, width: r[2].doubleValue, height: r[3].doubleValue)
    let find = c["find"] as? String
    Task {
      do {
        let (image, area) = try await capture(rect)
        reply(id, ["lines": try recognize(image, into: area, find: find)])
      } catch {
        fail(id, CGPreflightScreenCaptureAccess() ? "capture: \(error.localizedDescription)" : "no-screen-permission")
      }
    }
  case "ocr.file":
    guard let path = c["path"] as? String, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { return fail(id, "bad-image") }
    do {
      reply(id, ["lines": try recognize(image, into: CGRect(x: 0, y: 0, width: image.width, height: image.height), find: c["find"] as? String)])
    } catch {
      fail(id, "ocr: \(error.localizedDescription)")
    }
  case "activate":
    guard let app = c["app"] as? String, let a = NSRunningApplication.runningApplications(withBundleIdentifier: app).first else {
      return fail(id, "no-app")
    }
    reply(id, ["done": a.activate()])
  case "quit":
    reply(id, [:])
    out.sync {}
    exit(0)
  default:
    fail(id, "unknown command")
  }
}

Thread.detachNewThread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let c = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      send(["ok": false, "error": "bad json"])
      continue
    }
    DispatchQueue.main.async { handle(c) }
  }
  // The app went away: so do we.
  DispatchQueue.main.async {
    out.sync {}
    exit(0)
  }
}

send(["ev": "ready", "version": version])
CFRunLoopRun()
