// FoldStage Windows Audio & Now Playing Helper (.NET 8 / Windows 10 20348+ & Windows 11)
// Modes:
//   --list-apps              Prints JSON array of active audio sessions & visible desktop apps to stdout
//   --capture <exe|pid|all>  Streams mono Float32 PCM to stdout, JSON metadata/events to stderr

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;
using static FoldStageAudioWin.WasapiInterop;

namespace FoldStageAudioWin;

internal static class Program
{
    private static readonly string[] PlayerKeywords =
    {
        "cloudmusic", "netease", "spotify", "qqmusic", "kugou", "kuwo", "applemusic", "itunes",
        "foobar", "musicbee", "aimp", "vlc", "potplayer", "bilibili", "chrome", "msedge", "firefox", "brave"
    };

    private static readonly object StderrLock = new();

    private static void EmitEvent(object payload)
    {
        string line = JsonSerializer.Serialize(payload);
        lock (StderrLock)
        {
            Console.Error.WriteLine(line);
            Console.Error.Flush();
        }
    }

    private static bool IsPlayerLikely(string name, string exe)
    {
        string hay = (name + " " + exe).ToLowerInvariant();
        foreach (string kw in PlayerKeywords)
        {
            if (hay.Contains(kw, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static HashSet<uint> GetActiveAudioPids()
    {
        var pids = new HashSet<uint>();
        try
        {
            var enumerator = CreateDeviceEnumerator();
            // eRender = 0, eMultimedia = 1
            if (enumerator.GetDefaultAudioEndpoint(0, 1, out IMMDevice device) < 0 || device == null) return pids;
            Guid iid = IID_IAudioSessionManager2;
            if (device.Activate(ref iid, 23, IntPtr.Zero, out object mgrObj) < 0) return pids;
            var mgr = (IAudioSessionManager2)mgrObj;
            if (mgr.GetSessionEnumerator(out IAudioSessionEnumerator sessEnum) < 0) return pids;
            sessEnum.GetCount(out int count);
            for (int i = 0; i < count; i++)
            {
                if (sessEnum.GetSession(i, out IAudioSessionControl ctrl) < 0 || ctrl == null) continue;
                if (ctrl is IAudioSessionControl2 ctrl2)
                {
                    if (ctrl2.GetProcessId(out uint pid) >= 0 && pid > 0)
                    {
                        ctrl2.GetState(out int st);
                        // AudioSessionStateActive == 1, Inactive == 0
                        if (st == 1 || st == 0) pids.Add(pid);
                    }
                }
            }
        }
        catch { }
        return pids;
    }

    private static void ListApps()
    {
        var audioPids = GetActiveAudioPids();
        var byExe = new Dictionary<string, (string Name, string Exe, int Pid, bool Audio, bool Player)>(StringComparer.OrdinalIgnoreCase);

        foreach (Process p in Process.GetProcesses())
        {
            try
            {
                string exe = p.ProcessName;
                if (string.IsNullOrWhiteSpace(exe)) continue;
                bool hasAudio = audioPids.Contains((uint)p.Id);
                bool hasWin = p.MainWindowHandle != IntPtr.Zero && !string.IsNullOrWhiteSpace(p.MainWindowTitle);
                if (!hasAudio && !hasWin) continue;

                string displayName = hasWin ? p.MainWindowTitle : exe;
                if (displayName.Length > 48) displayName = exe;
                bool likely = IsPlayerLikely(displayName, exe);

                if (!byExe.TryGetValue(exe, out var prev))
                {
                    byExe[exe] = (exe, exe + ".exe", p.Id, hasAudio, likely);
                }
                else
                {
                    byExe[exe] = (prev.Name, prev.Exe, hasAudio ? p.Id : prev.Pid, prev.Audio || hasAudio, prev.Player || likely);
                }
            }
            catch { }
        }

        var list = byExe.Values
            .OrderByDescending(x => (x.Audio ? 2 : 0) + (x.Player ? 1 : 0))
            .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
            .Select(x => new
            {
                id = x.Name,
                name = x.Name,
                subtitle = x.Exe,
                pid = x.Pid,
                isAudioActive = x.Audio,
                isPlayerLikely = x.Player
            })
            .ToList();

        Console.Out.WriteLine(JsonSerializer.Serialize(list));
    }

    private static uint ResolveTargetPid(string target)
    {
        if (uint.TryParse(target, out uint directPid)) return directPid;
        string clean = target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? target[..^4] : target;
        var audioPids = GetActiveAudioPids();
        var procs = Process.GetProcessesByName(clean);
        // Prefer a process that currently has an active audio session
        foreach (var p in procs)
        {
            if (audioPids.Contains((uint)p.Id)) return (uint)p.Id;
        }
        // Next prefer one with a main window
        foreach (var p in procs)
        {
            try { if (p.MainWindowHandle != IntPtr.Zero) return (uint)p.Id; } catch { }
        }
        return procs.Length > 0 ? (uint)procs[0].Id : 0;
    }

    private static async Task RunNowPlayingLoopAsync(string target, CancellationToken ct)
    {
        GlobalSystemMediaTransportControlsSessionManager? mgr = null;
        try
        {
            mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch
        {
            return;
        }

        string lastArtKey = "";
        string cleanTarget = target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? target[..^4] : target;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                GlobalSystemMediaTransportControlsSession? session = null;
                var sessions = mgr.GetSessions();
                if (!string.Equals(target, "all", StringComparison.OrdinalIgnoreCase))
                {
                    foreach (var s in sessions)
                    {
                        string appId = s.SourceAppUserModelId ?? "";
                        if (appId.Contains(cleanTarget, StringComparison.OrdinalIgnoreCase))
                        {
                            session = s;
                            break;
                        }
                    }
                }
                session ??= mgr.GetCurrentSession();

                if (session != null)
                {
                    var props = await session.TryGetMediaPropertiesAsync();
                    var timeline = session.GetTimelineProperties();
                    var playback = session.GetPlaybackInfo();
                    string title = props?.Title ?? "";
                    if (!string.IsNullOrWhiteSpace(title))
                    {
                        string artist = props?.Artist ?? "";
                        string album = props?.AlbumTitle ?? "";
                        double duration = timeline?.EndTime.TotalSeconds ?? 0;
                        double elapsed = timeline?.Position.TotalSeconds ?? 0;
                        double rate = playback?.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing ? 1.0 : 0.0;
                        double ts = timeline != null && timeline.LastUpdatedTime.Year > 2000
                            ? timeline.LastUpdatedTime.ToUnixTimeMilliseconds() / 1000.0
                            : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

                        string? artB64 = null;
                        string artKey = $"{title}|{artist}|{album}";
                        if (artKey != lastArtKey && props?.Thumbnail != null)
                        {
                            try
                            {
                                using var stream = await props.Thumbnail.OpenReadAsync();
                                if (stream.Size > 0 && stream.Size < 600000)
                                {
                                    byte[] bytes = new byte[stream.Size];
                                    using var reader = new DataReader(stream);
                                    await reader.LoadAsync((uint)stream.Size);
                                    reader.ReadBytes(bytes);
                                    artB64 = Convert.ToBase64String(bytes);
                                    lastArtKey = artKey;
                                }
                            }
                            catch { }
                        }

                        var payload = new Dictionary<string, object?>
                        {
                            ["event"] = "nowplaying",
                            ["title"] = title,
                            ["artist"] = artist,
                            ["album"] = album,
                            ["duration"] = duration,
                            ["elapsed"] = elapsed,
                            ["playbackRate"] = rate,
                            ["timestamp"] = ts
                        };
                        if (artB64 != null) payload["art"] = artB64;
                        EmitEvent(payload);
                    }
                }
            }
            catch { }

            try { await Task.Delay(1800, ct); } catch { break; }
        }
    }

    private static async Task CaptureAllLoopbackAsync(CancellationToken ct)
    {
        var enumerator = CreateDeviceEnumerator();
        int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out IMMDevice device);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);

        Guid iidClient = IID_IAudioClient;
        hr = device.Activate(ref iidClient, 23, IntPtr.Zero, out object clientObj);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        var client = (IAudioClient)clientObj;

        hr = client.GetMixFormat(out IntPtr fmtPtr);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);

        try
        {
            var wf = Marshal.PtrToStructure<WAVEFORMATEX>(fmtPtr);
            bool isFloat = wf.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
            if (wf.wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf.cbSize >= 22)
            {
                var ext = Marshal.PtrToStructure<WAVEFORMATEXTENSIBLE>(fmtPtr);
                isFloat = ext.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            }

            hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200_0000, 0, fmtPtr, IntPtr.Zero);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);

            client.GetStreamLatency(out long latHns);
            double latMs = latHns / 10000.0;
            EmitEvent(new { @event = "stream", sampleRate = (int)wf.nSamplesPerSec, outLatencyMs = latMs });
            EmitEvent(new { @event = "status", message = $"Capturing Windows System Audio ({wf.nSamplesPerSec} Hz, {wf.nChannels} ch)" });

            await PumpCaptureClientAsync(client, wf.nChannels, wf.wBitsPerSample, isFloat, ct);
        }
        finally
        {
            Marshal.FreeCoTaskMem(fmtPtr);
        }
    }

    private static async Task CaptureProcessLoopbackAsync(uint pid, string targetName, CancellationToken ct)
    {
        var client = await ActivateProcessLoopbackAsync(pid, ct);
        var wf = new WAVEFORMATEX
        {
            wFormatTag = WAVE_FORMAT_IEEE_FLOAT,
            nChannels = 1,
            nSamplesPerSec = 48000,
            wBitsPerSample = 32,
            nBlockAlign = 4,
            nAvgBytesPerSec = 48000 * 4,
            cbSize = 0
        };
        IntPtr fmtPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WAVEFORMATEX>());
        try
        {
            Marshal.StructureToPtr(wf, fmtPtr, false);
            uint flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            int hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200_0000, 0, fmtPtr, IntPtr.Zero);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);

            EmitEvent(new { @event = "stream", sampleRate = 48000, outLatencyMs = 20.0 });
            EmitEvent(new { @event = "status", message = $"Capturing Windows process: {targetName} (PID {pid}, 48000 Hz)" });

            await PumpCaptureClientAsync(client, 1, 32, true, ct, watchPid: pid);
        }
        finally
        {
            Marshal.FreeHGlobal(fmtPtr);
        }
    }

    private static async Task PumpCaptureClientAsync(IAudioClient client, int channels, int bitsPerSample, bool isFloat, CancellationToken ct, uint watchPid = 0)
    {
        Guid iidCap = IID_IAudioCaptureClient;
        int hr = client.GetService(ref iidCap, out object capObj);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        var capture = (IAudioCaptureClient)capObj;

        hr = client.Start();
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);

        Stream stdout = Console.OpenStandardOutput();
        byte[] outBytes = Array.Empty<byte>();
        long lastPidCheck = Environment.TickCount64;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (watchPid > 0 && Environment.TickCount64 - lastPidCheck > 2000)
                {
                    lastPidCheck = Environment.TickCount64;
                    try { using var p = Process.GetProcessById((int)watchPid); if (p.HasExited) break; }
                    catch { break; }
                }

                hr = capture.GetNextPacketSize(out uint packetFrames);
                if (hr < 0) break;
                if (packetFrames == 0)
                {
                    await Task.Delay(8, ct);
                    continue;
                }

                while (packetFrames > 0 && !ct.IsCancellationRequested)
                {
                    hr = capture.GetBuffer(out IntPtr dataPtr, out uint numFrames, out uint flags, out _, out _);
                    if (hr < 0) break;

                    try
                    {
                        int frameCount = (int)numFrames;
                        int neededBytes = frameCount * 4;
                        if (outBytes.Length < neededBytes) outBytes = new byte[neededBytes];

                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || dataPtr == IntPtr.Zero)
                        {
                            Array.Clear(outBytes, 0, neededBytes);
                        }
                        else
                        {
                            ConvertToMonoFloat(dataPtr, frameCount, channels, bitsPerSample, isFloat, outBytes);
                        }
                        stdout.Write(outBytes, 0, neededBytes);
                    }
                    finally
                    {
                        capture.ReleaseBuffer(numFrames);
                    }

                    hr = capture.GetNextPacketSize(out packetFrames);
                    if (hr < 0) break;
                }
                stdout.Flush();
            }
        }
        finally
        {
            try { client.Stop(); } catch { }
        }
    }

    private static unsafe void ConvertToMonoFloat(IntPtr src, int frames, int channels, int bits, bool isFloat, byte[] dst)
    {
        fixed (byte* dstPtr = dst)
        {
            float* outF = (float*)dstPtr;
            float invCh = 1.0f / Math.Max(1, channels);
            if (isFloat && bits == 32)
            {
                float* inF = (float*)src;
                if (channels == 1)
                {
                    System.Buffer.MemoryCopy(inF, outF, frames * 4L, frames * 4L);
                }
                else
                {
                    for (int i = 0; i < frames; i++)
                    {
                        float s = 0;
                        int baseIdx = i * channels;
                        for (int c = 0; c < channels; c++) s += inF[baseIdx + c];
                        outF[i] = s * invCh;
                    }
                }
            }
            else if (!isFloat && bits == 16)
            {
                short* inS = (short*)src;
                float scale = invCh / 32768.0f;
                for (int i = 0; i < frames; i++)
                {
                    int s = 0;
                    int baseIdx = i * channels;
                    for (int c = 0; c < channels; c++) s += inS[baseIdx + c];
                    outF[i] = s * scale;
                }
            }
            else
            {
                new Span<float>(outF, frames).Clear();
            }
        }
    }

    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--list-apps"))
        {
            ListApps();
            return 0;
        }

        int capIdx = Array.IndexOf(args, "--capture");
        if (capIdx < 0 || capIdx + 1 >= args.Length)
        {
            Console.Error.WriteLine("Usage: foldstage-audio-win --list-apps | --capture <exeName|pid|all>");
            return 2;
        }

        string target = args[capIdx + 1];
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        _ = Task.Run(() => RunNowPlayingLoopAsync(target, cts.Token), cts.Token);

        while (!cts.IsCancellationRequested)
        {
            try
            {
                if (string.Equals(target, "all", StringComparison.OrdinalIgnoreCase))
                {
                    await CaptureAllLoopbackAsync(cts.Token);
                }
                else
                {
                    uint pid = ResolveTargetPid(target);
                    if (pid == 0)
                    {
                        EmitEvent(new { @event = "status", message = $"Waiting for {target} to start..." });
                        await Task.Delay(2000, cts.Token);
                        continue;
                    }
                    await CaptureProcessLoopbackAsync(pid, target, cts.Token);
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                EmitEvent(new
                {
                    @event = "status",
                    error = true,
                    message = $"Windows audio capture error ({ex.Message}). Per-app capture requires Windows 10 20348+ / Windows 11; try 'All System Audio' on older builds."
                });
                try { await Task.Delay(3000, cts.Token); } catch { break; }
            }
        }
        return 0;
    }
}
