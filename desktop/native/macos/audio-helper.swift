// FoldStage macOS Audio & Now Playing Helper (macOS 14.2+)
// Modes:
//   --list-apps                Prints JSON array of running GUI / audio-active apps to stdout
//   --capture <bundleId|all>   Streams mono Float32 PCM to stdout, JSON metadata/events to stderr

import AppKit
import AudioToolbox
import CoreAudio
import Foundation

func emitEvent(_ dict: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: dict),
     let line = String(data: data, encoding: .utf8) {
    FileHandle.standardError.write(Data((line + "\n").utf8))
  }
}

func getProp<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ def: T) -> T {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var v = def
  var size = UInt32(MemoryLayout<T>.size)
  let st = withUnsafeMutableBytes(of: &v) { raw in
    AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, raw.baseAddress!)
  }
  return st == noErr ? v : def
}

func getString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var s: Unmanaged<CFString>? = nil
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &s) == noErr, let v = s else { return nil }
  return v.takeRetainedValue() as String
}

func getArray(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var a = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &a) == noErr else { return [] }
  return a
}

func defaultOutput() -> AudioObjectID {
  getProp(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, AudioObjectID(0))
}

func outputLatencyMs() -> Double {
  let dev = defaultOutput()
  if dev == 0 { return 0 }
  let rate: Float64 = getProp(dev, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, Float64(48000))
  let lat: UInt32 = getProp(dev, kAudioDevicePropertyLatency, kAudioObjectPropertyScopeOutput, UInt32(0))
  let safety: UInt32 = getProp(dev, kAudioDevicePropertySafetyOffset, kAudioObjectPropertyScopeOutput, UInt32(0))
  let buf: UInt32 = getProp(dev, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, UInt32(0))
  var stream: UInt32 = 0
  if let s = getArray(dev, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput).first {
    stream = getProp(s, kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, UInt32(0))
  }
  return Double(lat + safety + buf + stream) / max(1, rate) * 1000.0
}

func bundleOf(pid: Int32) -> String? {
  NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
}

let KNOWN_PLAYER_KEYWORDS = [
  "music", "spotify", "163music", "qqmusic", "kugou", "kuwo", "foobar", "vlc",
  "iina", "tidal", "deezer", "soundcloud", "bilibili", "chrome", "safari", "firefox", "edge", "arc"
]

func isPlayerLikely(_ name: String, _ bundleId: String) -> Bool {
  let hay = (name + " " + bundleId).lowercased()
  return KNOWN_PLAYER_KEYWORDS.contains { hay.contains($0) }
}

func listAppsJSON() -> String {
  let procObjs = getArray(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
  var activeBundles = Set<String>()
  for obj in procObjs {
    let bid = getString(obj, kAudioProcessPropertyBundleID) ?? ""
    if !bid.isEmpty { activeBundles.insert(bid) }
  }

  var seen = Set<String>()
  var items: [[String: Any]] = []
  let regularBundles = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { $0.bundleIdentifier })
  for app in NSWorkspace.shared.runningApplications {
    guard let bid = app.bundleIdentifier, !bid.isEmpty else { continue }
    if seen.contains(bid) { continue }
    let isRegular = app.activationPolicy == .regular
    // Skip helper sub-bundles (e.g. com.google.Chrome.helper) when their parent app is already listed
    if !isRegular && regularBundles.contains(where: { bid.hasPrefix($0 + ".") }) { continue }
    let hasAudio = activeBundles.contains { $0 == bid || $0.hasPrefix(bid + ".") }
    if !isRegular && !hasAudio { continue }
    seen.insert(bid)
    let name = app.localizedName ?? bid
    items.append([
      "id": bid,
      "name": name,
      "subtitle": bid,
      "pid": Int(app.processIdentifier),
      "isAudioActive": hasAudio,
      "isPlayerLikely": isPlayerLikely(name, bid)
    ])
  }

  items.sort { a, b in
    let aa = (a["isAudioActive"] as? Bool ?? false) ? 2 : 0
    let ba = (b["isAudioActive"] as? Bool ?? false) ? 2 : 0
    let ap = (a["isPlayerLikely"] as? Bool ?? false) ? 1 : 0
    let bp = (b["isPlayerLikely"] as? Bool ?? false) ? 1 : 0
    if aa + ap != ba + bp { return aa + ap > ba + bp }
    return (a["name"] as? String ?? "") < (b["name"] as? String ?? "")
  }

  let data = (try? JSONSerialization.data(withJSONObject: items)) ?? Data("[]".utf8)
  return String(data: data, encoding: .utf8) ?? "[]"
}

func matchingProcessObjects(_ target: String) -> [AudioObjectID] {
  getArray(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).filter { obj in
    let bid = getString(obj, kAudioProcessPropertyBundleID) ?? ""
    return bid == target || bid.hasPrefix(target + ".") || bid.hasPrefix(target)
  }
}

final class NowPlayingPoller {
  private var busy = false
  private var lastArtKey = ""
  private let dylibPath: String
  private let targetBundle: String

  init(dylibPath: String, targetBundle: String) {
    self.dylibPath = dylibPath
    self.targetBundle = targetBundle
  }

  func start() {
    guard FileManager.default.fileExists(atPath: dylibPath) else { return }
    Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.poll() }
    poll()
  }

  private func poll() {
    if busy { return }
    busy = true
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
    p.arguments = [
      "-e",
      "use DynaLoader; my $h = DynaLoader::dl_load_file($ARGV[0], 0) or die DynaLoader::dl_error(); DynaLoader::dl_install_xsub('main::np', DynaLoader::dl_find_symbol($h, 'np_run')); np();",
      dylibPath
    ]
    var env = ProcessInfo.processInfo.environment
    env["FOLDSTAGE_NP_LASTART"] = lastArtKey
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.terminationHandler = { [weak self] _ in
      guard let self else { return }
      let data = out.fileHandleForReading.readDataToEndOfFile()
      if let line = data.split(separator: 0x0a).first,
         let j = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any] {
        let pid = Int32(truncating: (j["pid"] as? NSNumber) ?? 0)
        let npBundle = pid > 0 ? (bundleOf(pid: pid) ?? "") : ""
        let matchesTarget = self.targetBundle == "all" || npBundle.isEmpty || npBundle.hasPrefix(self.targetBundle)
        if matchesTarget, let title = j["Title"] as? String, !title.isEmpty {
          var ev: [String: Any] = [
            "event": "nowplaying",
            "title": title,
            "artist": j["Artist"] as? String ?? "",
            "album": j["Album"] as? String ?? "",
            "duration": (j["Duration"] as? NSNumber)?.doubleValue ?? 0,
            "elapsed": (j["ElapsedTime"] as? NSNumber)?.doubleValue ?? 0,
            "playbackRate": (j["PlaybackRate"] as? NSNumber)?.doubleValue ?? 1,
            "timestamp": (j["Timestamp"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970
          ]
          if let art = j["art"] as? String, !art.isEmpty {
            ev["art"] = art
            self.lastArtKey = j["artKey"] as? String ?? ""
          }
          emitEvent(ev)
        }
      }
      DispatchQueue.main.async { self.busy = false }
    }
    do { try p.run() } catch { busy = false }
  }
}

final class AudioTap {
  var tapID = AudioObjectID(kAudioObjectUnknown)
  var aggID = AudioObjectID(kAudioObjectUnknown)
  var procID: AudioDeviceIOProcID? = nil
  var procs: [AudioObjectID] = []
  var isGlobal = false
  var running: Bool { procID != nil }
  let queue = DispatchQueue(label: "foldstage.audio.io", qos: .userInteractive)

  func start(global: Bool, objs: [AudioObjectID]) -> Bool {
    stop()
    let desc: CATapDescription = global
      ? CATapDescription(stereoGlobalTapButExcludeProcesses: [])
      : CATapDescription(stereoMixdownOfProcesses: objs)
    desc.uuid = UUID()
    desc.isPrivate = true
    desc.muteBehavior = .unmuted
    desc.name = "foldstage-tap"

    var st = AudioHardwareCreateProcessTap(desc, &tapID)
    guard st == noErr else {
      emitEvent(["event": "status", "error": true, "message": "无法创建 macOS 音频捕获 (err \(st))，请在「系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制」中允许此应用。"])
      tapID = AudioObjectID(kAudioObjectUnknown)
      return false
    }

    let asbd: AudioStreamBasicDescription = getProp(tapID, kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, AudioStreamBasicDescription())
    let outUID = getString(defaultOutput(), kAudioDevicePropertyDeviceUID) ?? ""
    let dict: [String: Any] = [
      kAudioAggregateDeviceNameKey: "foldstage-tap",
      kAudioAggregateDeviceUIDKey: "foldstage-tap-" + UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]]
    ]
    st = AudioHardwareCreateAggregateDevice(dict as CFDictionary, &aggID)
    guard st == noErr else {
      emitEvent(["event": "status", "error": true, "message": "创建聚合音频设备失败 (\(st))"])
      stop()
      return false
    }

    let rate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000.0
    let interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
    let tapCh = Int(max(1, asbd.mChannelsPerFrame))

    st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, queue) { _, inData, _, _, _ in
      let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
      guard abl.count > 0 else { return }
      let first = interleaved
        ? (abl.lastIndex { Int($0.mNumberChannels) == tapCh } ?? (abl.count - 1))
        : max(0, abl.count - tapCh)
      let b0 = abl[first]
      guard b0.mDataByteSize > 0 else { return }
      let ch = interleaved ? Int(max(1, b0.mNumberChannels)) : 1
      let frames = Int(b0.mDataByteSize) / MemoryLayout<Float>.size / ch
      guard frames > 0 else { return }

      var mono = [Float](repeating: 0, count: frames)
      if interleaved {
        guard let p = b0.mData?.assumingMemoryBound(to: Float.self) else { return }
        for i in 0..<frames {
          var s: Float = 0
          for c in 0..<ch { s += p[i * ch + c] }
          mono[i] = s / Float(ch)
        }
      } else {
        let chs = max(1, abl.count - first)
        for c in first..<abl.count {
          guard let p = abl[c].mData?.assumingMemoryBound(to: Float.self) else { continue }
          for i in 0..<frames { mono[i] += p[i] / Float(chs) }
        }
      }
      mono.withUnsafeBytes { raw in
        if let base = raw.baseAddress {
          _ = write(STDOUT_FILENO, base, raw.count)
        }
      }
    }
    guard st == noErr else {
      emitEvent(["event": "status", "error": true, "message": "创建音频 IO 回调失败 (\(st))"])
      stop()
      return false
    }
    st = AudioDeviceStart(aggID, procID)
    guard st == noErr else {
      emitEvent(["event": "status", "error": true, "message": "启动音频捕获失败 (\(st))"])
      stop()
      return false
    }

    procs = objs
    isGlobal = global
    emitEvent(["event": "stream", "sampleRate": rate, "outLatencyMs": outputLatencyMs()])
    emitEvent(["event": "status", "message": global ? "正在监听全部系统音频 (\(Int(rate)) Hz)" : "已捕获目标应用音频 (\(objs.count) 个进程, \(Int(rate)) Hz)"])
    return true
  }

  func stop() {
    if let p = procID, aggID != kAudioObjectUnknown {
      AudioDeviceStop(aggID, p)
      AudioDeviceDestroyIOProcID(aggID, p)
    }
    procID = nil
    if aggID != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(aggID)
      aggID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
    procs = []
  }
}

// ---- Entry Point ----
let args = CommandLine.arguments
if args.contains("--list-apps") {
  print(listAppsJSON())
  exit(0)
}

guard let idx = args.firstIndex(of: "--capture"), idx + 1 < args.count else {
  fputs("Usage: foldstage-audio-mac --list-apps | --capture <bundleId|all>\n", stderr)
  exit(2)
}

let target = args[idx + 1]
let exeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().path
let dylibPath = (exeDir as NSString).appendingPathComponent("np.dylib")

let np = NowPlayingPoller(dylibPath: dylibPath, targetBundle: target)
np.start()

let tap = AudioTap()
var lastTry = 0.0

func tickAttach() {
  let now = Date().timeIntervalSince1970
  if target == "all" {
    if !tap.running && now - lastTry > 3 {
      lastTry = now
      _ = tap.start(global: true, objs: [])
    }
  } else {
    let objs = matchingProcessObjects(target)
    if objs.isEmpty {
      if tap.running {
        tap.stop()
        emitEvent(["event": "status", "message": "等待目标应用出声 (\(target))..."])
      } else if now - lastTry > 5 {
        lastTry = now
        emitEvent(["event": "status", "message": "等待目标应用运行或播放声音 (\(target))..."])
      }
    } else if (!tap.running || Set(objs) != Set(tap.procs)) && now - lastTry > (tap.running ? 2 : 5) {
      lastTry = now
      _ = tap.start(global: false, objs: objs)
    }
  }
}

Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in tickAttach() }
Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
  if tap.running {
    emitEvent(["event": "stream", "outLatencyMs": outputLatencyMs()])
  }
}

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

tickAttach()
NSApplication.shared.setActivationPolicy(.prohibited)
RunLoop.main.run()
