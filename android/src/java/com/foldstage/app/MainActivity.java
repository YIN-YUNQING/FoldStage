package com.foldstage.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Range;
import android.util.Size;
import android.util.SizeF;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * FoldStage Android Shell:
 *   - Serves self-contained offline 3D hologram web engine & synced Live2D models via LocalServer
 *   - Syncs Live2D models over USB-ADB tunnel (http://127.0.0.1:8772) into private app storage
 *   - Provides continuous fold angle (calibrated accelerometer on Galaxy Z Fold 5 + fallback for other devices)
 *   - Provides optional Camera2 rear-camera AR transparent window with thermal guard
 */
public class MainActivity extends Activity implements SensorEventListener {
    private static final String COMPANION_BASE = "http://127.0.0.1:8772";
    private static final int REQ_CAM = 101;
    private static final int TYPE_HINGE_ANGLE = 36;

    private LocalServer localServer;
    private File modelsDir;
    private WebView webView;
    private SensorManager sensorManager;
    private Sensor accelSensor;
    private Sensor hingeSensor;
    private boolean isFold5 = false;
    private boolean hasHingeSensor = false;
    private boolean useAccelForFold = false;
    private volatile float latestHinge = -1f;
    private float smoothDeg = -1f;
    private boolean pageReady = false;
    private PermissionRequest pendingWebPermission = null;
    private final AtomicBoolean syncing = new AtomicBoolean(false);

    // ---- Optional AR transparent window (rear camera behind WebView) ----
    private TextureView arView;
    private CameraDevice rearCam;
    private CameraCaptureSession rearSession;
    private CaptureRequest.Builder rearReq;
    private HandlerThread camThread;
    private Handler camHandler;
    private volatile boolean arWanted = false;
    private volatile String arState = "off";
    private volatile String arInfoJson = "{}";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String modelUpper = (Build.MODEL == null ? "" : Build.MODEL).toUpperCase();
        isFold5 = modelUpper.startsWith("SM-F946");

        Window win = getWindow();
        win.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        win.setStatusBarColor(Color.BLACK);
        win.setNavigationBarColor(Color.BLACK);
        WindowManager.LayoutParams lp = win.getAttributes();
        lp.screenBrightness = 0.78f;
        if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        win.setAttributes(lp);
        if (Build.VERSION.SDK_INT >= 30) {
            win.setDecorFitsSystemWindows(false);
        }

        modelsDir = new File(getFilesDir(), "models");
        if (!modelsDir.exists()) modelsDir.mkdirs();

        localServer = new LocalServer(this, modelsDir, this::syncFromCompanionAsync);
        int localPort = 18772;
        try {
            localPort = localServer.start();
        } catch (Exception e) {
            e.printStackTrace();
        }

        WebView.setWebContentsDebuggingEnabled(true);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);
        if (sensorManager != null) {
            accelSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            hingeSensor = sensorManager.getDefaultSensor(TYPE_HINGE_ANGLE);
            hasHingeSensor = hingeSensor != null;
            // Galaxy Z Fold 5 HAL quantizes TYPE_HINGE_ANGLE to 0/90/180; accelerometer on upper screen gives 0.1 deg precision.
            // Other foldables with a hinge sensor use TYPE_HINGE_ANGLE by default (user can also switch in panel).
            useAccelForFold = isFold5;
        }

        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public float getHingeAngle() { return latestHinge; }

            @JavascriptInterface
            public String getDeviceInfo() {
                try {
                    JSONObject j = new JSONObject();
                    j.put("model", Build.MODEL == null ? "Unknown" : Build.MODEL);
                    j.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
                    j.put("profile", isFold5 ? "fold5" : (hasHingeSensor ? "foldable-generic" : "flat-generic"));
                    j.put("isFold5", isFold5);
                    j.put("hasHingeSensor", hasHingeSensor);
                    j.put("companionUrl", COMPANION_BASE);
                    return j.toString();
                } catch (Exception e) {
                    return "{\"profile\":\"flat-generic\",\"companionUrl\":\"" + COMPANION_BASE + "\"}";
                }
            }

            @JavascriptInterface
            public void setFoldSensorMode(String mode) {
                useAccelForFold = "accel".equals(mode);
            }

            @JavascriptInterface
            public String getPrefs() {
                return getSharedPreferences("foldstage", MODE_PRIVATE).getString("prefs", "{}");
            }

            @JavascriptInterface
            public void setPrefs(String json) {
                if (json != null && json.length() < 30000) {
                    getSharedPreferences("foldstage", MODE_PRIVATE).edit().putString("prefs", json).apply();
                }
            }

            @JavascriptInterface
            public void syncModels() {
                syncFromCompanionAsync();
            }

            @JavascriptInterface
            public void arStart() { arWanted = true; runOnUiThread(() -> openRear()); }

            @JavascriptInterface
            public void arStop() { arWanted = false; runOnUiThread(() -> closeRear()); }

            @JavascriptInterface
            public int thermal() {
                return Build.VERSION.SDK_INT >= 29
                        ? ((PowerManager) getSystemService(POWER_SERVICE)).getCurrentThermalStatus()
                        : 0;
            }

            @JavascriptInterface
            public String arInfo() {
                return "{\"state\":\"" + arState + "\"," + arInfoJson.substring(1);
            }

            @JavascriptInterface
            public void arSetQuad(String csv) {
                final String[] p = csv.split(",");
                if (p.length < 8) return;
                runOnUiThread(() -> {
                    if (arView == null || arView.getWidth() == 0) return;
                    float css2px = p.length > 8
                            ? arView.getWidth() / Float.parseFloat(p[8])
                            : getResources().getDisplayMetrics().density;
                    float w = arView.getWidth(), h = arView.getHeight();
                    float[] src = { 0, 0, w, 0, w, h, 0, h };
                    float[] dst = new float[8];
                    for (int i = 0; i < 8; i++) dst[i] = Float.parseFloat(p[i]) * css2px;
                    Matrix m = new Matrix();
                    if (m.setPolyToPoly(src, 0, dst, 0, 4)) arView.setTransform(m);
                    if (rearSession != null) arView.setAlpha(1f);
                });
            }

            @JavascriptInterface
            public String arSnapshot(final int w, final int h) {
                final String[] out = { "" };
                final CountDownLatch done = new CountDownLatch(1);
                runOnUiThread(() -> {
                    try {
                        if (arView != null && arView.isAvailable() && rearSession != null) {
                            Bitmap b = arView.getBitmap(Math.max(16, Math.min(640, w)), Math.max(16, Math.min(480, h)));
                            ByteArrayOutputStream bo = new ByteArrayOutputStream();
                            b.compress(Bitmap.CompressFormat.JPEG, 85, bo);
                            out[0] = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
                            b.recycle();
                        }
                    } catch (Exception e) { out[0] = ""; }
                    done.countDown();
                });
                try { done.await(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
                return out[0];
            }

            @JavascriptInterface
            public void arLock(final boolean lock, final int ev) {
                if (camHandler == null) return;
                camHandler.post(() -> {
                    try {
                        if (rearReq == null || rearSession == null) return;
                        rearReq.set(CaptureRequest.CONTROL_AE_LOCK, lock);
                        rearReq.set(CaptureRequest.CONTROL_AWB_LOCK, lock);
                        rearReq.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, ev);
                        rearSession.setRepeatingRequest(rearReq.build(), null, camHandler);
                    } catch (Exception e) {
                        arState = "lock-error:" + e.getClass().getSimpleName();
                    }
                });
            }

            @JavascriptInterface
            public void setScreenBrightness(final float b) {
                runOnUiThread(() -> {
                    WindowManager.LayoutParams p = getWindow().getAttributes();
                    p.screenBrightness = Math.max(0.15f, Math.min(1.0f, b));
                    getWindow().setAttributes(p);
                });
            }
        }, "NativeFoldStage");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushHingeToWeb();
                syncFromCompanionAsync();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    view.postDelayed(() -> view.reload(), 1500);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        pendingWebPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
                    }
                });
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        arView = new TextureView(this);
        arView.setAlpha(0f);
        root.addView(arView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyImmersive();

        if (Build.VERSION.SDK_INT >= 29) {
            ((PowerManager) getSystemService(POWER_SERVICE)).addThermalStatusListener(getMainExecutor(), st -> {
                if (st >= PowerManager.THERMAL_STATUS_CRITICAL && rearCam != null) {
                    closeRear();
                    arState = "too-hot";
                    webView.evaluateJavascript("window.onArTooHot && window.onArTooHot(" + st + ")", null);
                }
            });
        }

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
        }

        webView.loadUrl("http://127.0.0.1:" + localPort + "/index.html?native=1");
    }

    // ---- USB Model Sync from Desktop Companion (127.0.0.1:8772 via adb reverse) ----
    private void syncFromCompanionAsync() {
        if (!syncing.compareAndSet(false, true)) return;
        new Thread(() -> {
            try {
                String remoteStr = httpGetString(COMPANION_BASE + "/v1/models", 4000);
                if (remoteStr == null) return;
                JSONObject remoteJson = new JSONObject(remoteStr);
                JSONArray remoteModels = remoteJson.optJSONArray("models");
                if (remoteModels == null) return;

                Map<String, Long> localVersions = new HashMap<>();
                File manifestFile = new File(modelsDir, "manifest.json");
                if (manifestFile.isFile()) {
                    try {
                        JSONObject localJson = new JSONObject(readFileText(manifestFile));
                        JSONArray arr = localJson.optJSONArray("models");
                        if (arr != null) {
                            for (int i = 0; i < arr.length(); i++) {
                                JSONObject m = arr.getJSONObject(i);
                                localVersions.put(m.getString("id"), m.optLong("version", 0L));
                            }
                        }
                    } catch (Exception ignored) {}
                }

                Set<String> keepIds = new HashSet<>();
                int total = remoteModels.length();
                int downloaded = 0;
                boolean changed = false;

                for (int i = 0; i < total; i++) {
                    JSONObject m = remoteModels.getJSONObject(i);
                    String id = m.getString("id");
                    String name = m.optString("name", id);
                    long ver = m.optLong("version", 0L);
                    keepIds.add(id);

                    File modelDir = new File(modelsDir, id);
                    Long curVer = localVersions.get(id);
                    boolean needsDownload = (curVer == null || curVer != ver || !new File(modelDir, m.optString("modelFile", "")).isFile());
                    if (needsDownload) {
                        reportSyncStatus("syncing", "正在同步模型 (" + (i + 1) + "/" + total + "): " + name, i, total);
                        File tmpDir = new File(modelsDir, id + ".tmp");
                        deleteRecursive(tmpDir);
                        tmpDir.mkdirs();
                        JSONArray files = m.optJSONArray("files");
                        if (files != null) {
                            for (int fIdx = 0; fIdx < files.length(); fIdx++) {
                                String rel = files.getString(fIdx);
                                String url = COMPANION_BASE + "/v1/models/" + encodeSeg(id) + "/" + encodePath(rel);
                                File dest = new File(tmpDir, rel);
                                File parent = dest.getParentFile();
                                if (parent != null && !parent.exists()) parent.mkdirs();
                                downloadFile(url, dest);
                            }
                        }
                        deleteRecursive(modelDir);
                        tmpDir.renameTo(modelDir);
                        downloaded++;
                        changed = true;
                    }
                }

                // Remove models deleted on PC
                File[] existing = modelsDir.listFiles();
                if (existing != null) {
                    for (File f : existing) {
                        if (f.isDirectory() && !keepIds.contains(f.getName())) {
                            deleteRecursive(f);
                            changed = true;
                        }
                    }
                }

                if (changed || !manifestFile.isFile() || localVersions.size() != keepIds.size()) {
                    writeFileText(manifestFile, remoteStr);
                    changed = true;
                }

                String summary = downloaded > 0
                        ? "已同步 " + total + " 个模型（更新 " + downloaded + " 个），离线可用"
                        : "模型已是最新（共 " + total + " 个，离线可用）";
                reportSyncStatus("done", summary, total, total);

                if (changed) {
                    runOnUiThread(() -> {
                        if (webView != null) {
                            webView.evaluateJavascript("window.onModelsUpdated && window.onModelsUpdated()", null);
                        }
                    });
                }
            } catch (Exception e) {
                reportSyncStatus("error", "同步失败：" + e.getMessage(), 0, 0);
            } finally {
                syncing.set(false);
            }
        }, "foldstage-sync").start();
    }

    private void reportSyncStatus(String state, String message, int synced, int total) {
        try {
            JSONObject j = new JSONObject();
            j.put("state", state);
            j.put("message", message);
            j.put("syncedModels", synced);
            j.put("totalModels", total);
            j.put("deviceModel", Build.MODEL == null ? "Android" : Build.MODEL);
            byte[] body = j.toString().getBytes(StandardCharsets.UTF_8);
            HttpURLConnection c = (HttpURLConnection) new URL(COMPANION_BASE + "/v1/device-status").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(2000);
            c.setReadTimeout(2000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) { os.write(body); }
            c.getResponseCode();
            c.disconnect();
        } catch (Exception ignored) {}
    }

    private static String encodeSeg(String s) throws Exception {
        return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
    }

    private static String encodePath(String rel) throws Exception {
        String[] segs = rel.split("/");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < segs.length; i++) {
            if (i > 0) sb.append('/');
            sb.append(encodeSeg(segs[i]));
        }
        return sb.toString();
    }

    private static String httpGetString(String url, int timeoutMs) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            if (c.getResponseCode() != 200) { c.disconnect(); return null; }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            try (InputStream is = c.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
            }
            c.disconnect();
            return new String(baos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    private static void downloadFile(String url, File dest) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(30000);
        int code = c.getResponseCode();
        if (code != 200) {
            c.disconnect();
            throw new RuntimeException("HTTP " + code + " downloading " + url);
        }
        try (InputStream is = new BufferedInputStream(c.getInputStream());
             OutputStream os = new FileOutputStream(dest)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = is.read(buf)) != -1) os.write(buf, 0, n);
        } finally {
            c.disconnect();
        }
    }

    private static String readFileText(File f) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (InputStream is = new FileInputStream(f)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
        }
        return new String(baos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void writeFileText(File f, String text) throws Exception {
        try (OutputStream os = new FileOutputStream(f)) {
            os.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }

    private void applyImmersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController ctrl = getWindow().getInsetsController();
            if (ctrl != null) {
                ctrl.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                ctrl.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (arWanted) openRear();
        applyImmersive();
        if (sensorManager != null) {
            if (accelSensor != null) sensorManager.registerListener(this, accelSensor, SensorManager.SENSOR_DELAY_UI);
            if (hingeSensor != null) sensorManager.registerListener(this, hingeSensor, SensorManager.SENSOR_DELAY_UI);
        }
    }

    @Override
    protected void onPause() {
        closeRear();
        super.onPause();
        if (sensorManager != null) sensorManager.unregisterListener(this);
    }

    @Override
    protected void onDestroy() {
        if (localServer != null) localServer.stop();
        super.onDestroy();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.values == null || event.values.length == 0) return;
        int type = event.sensor.getType();
        if (type == TYPE_HINGE_ANGLE && !useAccelForFold) {
            float rawDeg = Math.max(55f, Math.min(180f, event.values[0]));
            updateSmoothedAngle(rawDeg);
        } else if (type == Sensor.TYPE_ACCELEROMETER && useAccelForFold && event.values.length >= 3) {
            double ax = event.values[0], ay = event.values[1], az = event.values[2];
            double horiz = Math.hypot(ax, ay);
            float rawDeg = (float) (90.0 + Math.toDegrees(Math.atan2(az, horiz)));
            rawDeg = Math.max(55f, Math.min(180f, rawDeg));
            updateSmoothedAngle(rawDeg);
        }
    }

    private void updateSmoothedAngle(float rawDeg) {
        if (smoothDeg < 0f) smoothDeg = rawDeg;
        else smoothDeg += (rawDeg - smoothDeg) * 0.25f;
        if (Math.abs(smoothDeg - latestHinge) >= 0.25f || latestHinge < 0f) {
            latestHinge = Math.round(smoothDeg * 10f) / 10f;
            pushHingeToWeb();
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    private void pushHingeToWeb() {
        if (!pageReady || latestHinge < 0 || webView == null) return;
        final String js = "window.onNativeHingeAngle && window.onNativeHingeAngle(" + latestHinge + ");";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    // ---- Rear Camera2 for AR transparent window ----
    private void openRear() {
        if (rearCam != null || !arWanted) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { arState = "no-permission"; return; }
        if (!arView.isAvailable()) {
            arView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
                public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) { openRear(); }
                public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {}
                public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { return true; }
                public void onSurfaceTextureUpdated(SurfaceTexture st) {}
            });
            arState = "waiting-surface";
            return;
        }
        try {
            if (camThread == null) {
                camThread = new HandlerThread("ar-cam");
                camThread.start();
                camHandler = new Handler(camThread.getLooper());
            }
            CameraManager cm = (CameraManager) getSystemService(CAMERA_SERVICE);
            String id = null;
            for (String c : cm.getCameraIdList()) {
                Integer f = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (f != null && f == CameraCharacteristics.LENS_FACING_BACK) { id = c; break; }
            }
            if (id == null) { arState = "no-rear"; return; }
            CameraCharacteristics ch = cm.getCameraCharacteristics(id);
            StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size best = null;
            for (Size z : map.getOutputSizes(SurfaceTexture.class)) {
                if (z.getWidth() * 3 == z.getHeight() * 4 && z.getWidth() <= 1024 && (best == null || z.getWidth() > best.getWidth())) {
                    best = z;
                }
            }
            if (best == null) best = map.getOutputSizes(SurfaceTexture.class)[0];
            float[] fl = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
            SizeF ss = ch.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
            Integer so = ch.get(CameraCharacteristics.SENSOR_ORIENTATION);
            arInfoJson = "{\"id\":\"" + id + "\",\"w\":" + best.getWidth() + ",\"h\":" + best.getHeight()
                    + ",\"focal\":" + (fl != null && fl.length > 0 ? fl[0] : 0)
                    + ",\"sensorW\":" + (ss != null ? ss.getWidth() : 0)
                    + ",\"sensorH\":" + (ss != null ? ss.getHeight() : 0)
                    + ",\"orient\":" + (so != null ? so : 0)
                    + ",\"rotation\":" + getWindowManager().getDefaultDisplay().getRotation() + "}";
            arState = "opening";
            final Size size = best;
            cm.openCamera(id, new CameraDevice.StateCallback() {
                public void onOpened(CameraDevice cam) {
                    rearCam = cam;
                    try {
                        SurfaceTexture st = arView.getSurfaceTexture();
                        st.setDefaultBufferSize(size.getWidth(), size.getHeight());
                        final Surface sf = new Surface(st);
                        rearReq = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        rearReq.addTarget(sf);
                        try {
                            Range<Integer>[] rs = ((CameraManager) getSystemService(CAMERA_SERVICE))
                                    .getCameraCharacteristics(cam.getId())
                                    .get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
                            Range<Integer> pick = null;
                            if (rs != null) {
                                for (Range<Integer> r : rs) {
                                    if (r.getUpper() <= 24 && (pick == null || r.getUpper() > pick.getUpper())) pick = r;
                                }
                            }
                            if (pick != null) rearReq.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, pick);
                        } catch (Exception ignored) {}
                        cam.createCaptureSession(Collections.singletonList(sf), new CameraCaptureSession.StateCallback() {
                            public void onConfigured(CameraCaptureSession sess) {
                                rearSession = sess;
                                try {
                                    sess.setRepeatingRequest(rearReq.build(), null, camHandler);
                                    arState = "running";
                                } catch (Exception e) { arState = "repeat-error:" + e.getClass().getSimpleName(); }
                            }
                            public void onConfigureFailed(CameraCaptureSession sess) { arState = "configure-failed"; }
                        }, camHandler);
                    } catch (Exception e) { arState = "session-error:" + e.getClass().getSimpleName(); }
                }
                public void onDisconnected(CameraDevice cam) { arState = "disconnected"; cam.close(); rearCam = null; rearSession = null; }
                public void onError(CameraDevice cam, int err) { arState = "error:" + err; cam.close(); rearCam = null; rearSession = null; }
            }, camHandler);
        } catch (Exception e) {
            arState = "open-error:" + e.getClass().getSimpleName();
        }
    }

    private void closeRear() {
        try { if (rearSession != null) rearSession.close(); } catch (Exception ignored) {}
        try { if (rearCam != null) rearCam.close(); } catch (Exception ignored) {}
        rearSession = null; rearCam = null; rearReq = null;
        if (arView != null) arView.setAlpha(0f);
        if (!arWanted) arState = "off";
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAM && pendingWebPermission != null) {
            PermissionRequest req = pendingWebPermission;
            pendingWebPermission = null;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                req.grant(req.getResources());
            } else {
                req.deny();
            }
        }
    }
}
