# FoldStage

**FoldStage** 是一个面向折叠屏手机的**裸眼 3D Live2D 全息舞台**开源框架，包含 Android 独立全息端与跨平台（**macOS / Windows**）桌面伴侣工具。

把折叠屏半折放在桌上：下半屏作为 3D 地板，上半屏作为纵深背墙。前置摄像头实时追踪你的眼睛三维位置，通过离轴透视投影（Robert Kooima 方法）+ 折痕圆弧分条渲染，为你当前视角呈现立体裸眼 3D 舞台；连接电脑 USB 后，还可实时捕获电脑上**任意指定播放器 App** 的音乐节拍与歌曲信息，驱动 Live2D 演奏模型（站姿乐手 / 坐姿鼓组）踩点演出。

> **重要说明（设备适配范围）**
> - **已实机验证并完成校准的设备：仅限 Samsung Galaxy Z Fold 5（`SM-F9460`）**。因为作者目前只有 Fold 5 实机，屏幕物理尺寸（`14.70 × 12.2 cm`）、前置屏下镜头位置、连续折角加速度计解算均基于 Fold 5 实测。
> - **其他折叠屏 / 普通直板手机 / 平板**：内置**基础退化体验模式**（非 Fold 5 设备可切换「通用折叠屏」或「直板 / 平板」预设，默认展平 180° 并关闭折痕压暗，支持在调参面板手动调节屏幕尺寸、折角与触控预览）。欢迎提交 PR 补充更多机型的实测参数！
> - **本公开仓库仅包含代码，不包含任何角色 Live2D 模型素材**。请使用桌面端「模型库」窗口导入你自己的 Cubism 3/4 Live2D `.zip` 模型包。

---

## 核心特性

1. **Android 独立离线全息端（`com.foldstage.app`）**
   - 离轴透视 + 折痕圆弧分条渲染 + 折痕亮度平衡蒙版。
   - **完全离线前摄眼追**：将 MediaPipe FaceLandmarker（WASM + `.task`）与 Web 引擎打进 APK 本地服务，断网/无代理也能运行眼追（失败自动回退触控预览）。
   - **通用 Live2D 模型渲染**：自动按实际不透明像素包围盒居中并让角色脚底严丝合缝贴合地面或舞台台面；自动识别站姿展示模型、站姿演奏模型（吉他/贝斯/主唱/键盘等）与多层鼓组模型。
   - **可选 AR 透明窗**：利用后置主摄在背墙透出真实环境（默认关闭，内置温控保护）。
   - **离线模型存储**：通过电脑端同步进手机后，拔掉 USB 线依然可以离线切换和展示模型。

2. **跨平台桌面伴侣（macOS & Windows）**
   - **统一图形界面 Studio GUI**：无需命令行操作，打开即可管理 USB 设备、选择音源 App、导入 `.zip` 模型并一键同步到手机。
   - **USB 自动识别（ADB 隧道）**：自动检测通过 USB 连接的 Android 设备并建立 `adb reverse tcp:8772 tcp:8772`，支持一键安装/启动 APK。
   - **通用音源 App 指定**：
     - **macOS 14.2+**：原生 Core Audio Process Tap，可指定任意正在运行的 App（网易云、Spotify、Apple Music、QQ 音乐、浏览器等）或「All System Audio」，配合 MediaRemote 读取歌名/歌手/封面/进度。
     - **Windows 10 (20348+) / Windows 11**：原生 WASAPI Process Loopback 按进程捕获指定播放器音频（旧版 Windows 支持 All System Audio 回环），配合 Windows GSMTC 读取歌名/歌手/封面/进度。
   - **共享实时节拍引擎**：三频段频谱通量 + 8 秒自相关 BPM 估计 + 梳状相位 + 锁相平滑 + 4/4 小节重拍识别；另附内置演示节拍器便于无音乐时测试。
   - **`.zip` 模型智能导入**：纯 Node.js 解压与解析，自动识别 `*.model3.json`、贴图和动作文件；检测到 `mtn_play01_*` / `mtn_play02_*` 等演奏动作时自动归类为「音乐演奏模型」。

---

## 目录结构

```text
foldstage/
├── android/                  # Android 原生壳 (com.foldstage.app) 与构建脚本
├── web/                      # 裸眼 3D Live2D 全息 Web 引擎
├── desktop/
│   ├── core/                 # 跨平台伴侣服务 (Node.js 零外部依赖): HTTP/SSE、DSP、ZIP 导入、ADB
│   ├── ui/                   # 桌面伴侣图形界面 Studio GUI
│   ├── native/
│   │   ├── macos/            # macOS 原生 Core Audio 捕获助手 + WKWebView .app 封装
│   │   └── windows/          # Windows 原生 WASAPI Process Loopback + GSMTC (.NET 8)
│   └── start.mjs             # 跨平台启动入口
├── scripts/fetch-deps.mjs    # 拉取前端依赖与离线 MediaPipe 资源（不进仓库）
└── docs/USB-MUSIC-PROTOCOL.md # 开放 USB 音乐与模型同步协议说明
```

---

## 快速开始

### 1. 环境准备
- **Node.js 18+**（macOS / Windows 通用，无 `npm install` 依赖）
- **Android Platform-Tools (`adb`)**（手机需开启开发者选项 -> USB 调试）
- 构建 Android APK 需要 **JDK 11+** 与 **Android SDK (`ANDROID_HOME`)**（也可直接从 GitHub Actions / Releases 下载预构建产物）

### 2. 构建 Android APK
```bash
node scripts/fetch-deps.mjs
bash android/build.sh
# 生成 android/out/foldstage.apk
```

### 3. 启动桌面伴侣

#### macOS（14.2+）
```bash
# 编译 macOS 音频捕获助手与原生窗口 App
zsh desktop/native/macos/build.sh

# 方式 A：直接双击打开生成的桌面应用
open "desktop/native/macos/FoldStage Companion.app"

# 方式 B：命令行启动
node desktop/start.mjs
```
> 首次捕获系统音频时，macOS 会提示允许「屏幕与系统音频录制」权限，同意后重新点击「开始识别音乐」即可。

#### Windows（Windows 10 20348+ / Windows 11）
1. 安装 [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)（或直接将预编译的 `foldstage-audio-win.exe` 放到 `desktop/native/windows/publish/`）。
2. 双击运行 `desktop\native\windows\FoldStage-Windows.bat`（首次运行会自动编译 `foldstage-audio-win.exe` 并以独立应用窗口打开 Studio GUI）。

### 4. 导入模型并同步到手机
1. 用 USB 数据线连接手机并在手机上允许「USB 调试」。
2. 在桌面端点击 **「安装 / 更新 FoldStage APK」** -> **「在手机上启动」**。
3. 将 Live2D 模型 `.zip` 压缩包拖入桌面端的 **「3. Live2D 模型库」** 窗口：
   - 压缩包内包含 `*.model3.json`、`*.moc3`、`textures/`（以及可选 `motions/`、`expressions/`）即可自动识别。
   - 包含演奏动作（如 `mtn_play01_01.motion3.json` 等）的模型会自动标记为 **音乐演奏**，有音乐播放时自动切入 3D 舞台并踩点演出。
4. 点击 **「同步模型到手机」**（或等待自动同步完成）。同步完成后拔掉数据线也能离线浏览模型。
5. 在 **「2. 电脑音源选择与节拍识别」** 中选择你的播放器 App，点击 **「开始识别音乐」**，手机端即可随音乐实时演出！

---

## 开放 USB 音乐协议

如果你想用自己的脚本（Python / Node / OBS / Foobar2000 插件等）或 Linux 桌面端给 FoldStage 推送节拍与曲目信息，直接向 `POST http://127.0.0.1:8772/v1/music` 发送 JSON 即可。详见 [docs/USB-MUSIC-PROTOCOL.md](docs/USB-MUSIC-PROTOCOL.md)。

## License

MIT License — 见 [LICENSE](LICENSE)。
Live2D Cubism Core SDK 归 Live2D Inc. 所有，由 `scripts/fetch-deps.mjs` 在本地构建时从官方地址下载，不包含在本仓库中。
