package com.foldstage.app;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lightweight local HTTP server on 127.0.0.1 for offline WebView loading:
 *   - Serves bundled APK assets/web/* (HTML, JS, WASM, MediaPipe .task)
 *   - Serves synced Live2D models stored privately in filesDir/models/*
 *   - Exposes GET /local/models and POST /local/sync
 */
public final class LocalServer {
    private final Context context;
    private final File modelsDir;
    private final Runnable onSyncRequest;
    private ServerSocket serverSocket;
    private ExecutorService pool;
    private volatile boolean running = false;
    private int port = 18772;

    public LocalServer(Context context, File modelsDir, Runnable onSyncRequest) {
        this.context = context.getApplicationContext();
        this.modelsDir = modelsDir;
        this.onSyncRequest = onSyncRequest;
    }

    public int start() throws IOException {
        if (running) return port;
        try {
            serverSocket = new ServerSocket(18772, 32, InetAddress.getByName("127.0.0.1"));
        } catch (IOException e) {
            serverSocket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
        }
        port = serverSocket.getLocalPort();
        running = true;
        pool = Executors.newFixedThreadPool(8);
        Thread acceptThread = new Thread(() -> {
            while (running) {
                try {
                    final Socket sock = serverSocket.accept();
                    pool.execute(() -> handle(sock));
                } catch (IOException ignored) {
                    if (!running) break;
                }
            }
        }, "foldstage-http");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return port;
    }

    public int getPort() {
        return port;
    }

    public void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
        if (pool != null) pool.shutdownNow();
    }

    private void handle(Socket sock) {
        try (Socket s = sock) {
            s.setSoTimeout(10000);
            BufferedReader br = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
            String reqLine = br.readLine();
            if (reqLine == null || reqLine.isEmpty()) return;
            String[] parts = reqLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String rawPath = parts[1];
            int q = rawPath.indexOf('?');
            if (q >= 0) rawPath = rawPath.substring(0, q);
            String path = URLDecoder.decode(rawPath, "UTF-8");

            // Drain HTTP headers
            String line;
            while ((line = br.readLine()) != null && !line.isEmpty()) {
                // ignore
            }

            OutputStream out = s.getOutputStream();
            if ("OPTIONS".equals(method)) {
                writeStatus(out, 204, "No Content", "text/plain", 0);
                out.flush();
                return;
            }

            if ("/local/models".equals(path)) {
                File manifest = new File(modelsDir, "manifest.json");
                if (manifest.isFile()) {
                    serveFile(out, manifest, "application/json; charset=utf-8");
                } else {
                    byte[] empty = "{\"models\":[]}".getBytes(StandardCharsets.UTF_8);
                    writeStatus(out, 200, "OK", "application/json; charset=utf-8", empty.length);
                    out.write(empty);
                    out.flush();
                }
                return;
            }

            if ("/local/sync".equals(path) && "POST".equals(method)) {
                if (onSyncRequest != null) onSyncRequest.run();
                byte[] ok = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
                writeStatus(out, 200, "OK", "application/json; charset=utf-8", ok.length);
                out.write(ok);
                out.flush();
                return;
            }

            if (path.startsWith("/models/")) {
                String rel = sanitize(path.substring("/models/".length()));
                if (rel == null) { writeNotFound(out); return; }
                File f = new File(modelsDir, rel).getCanonicalFile();
                File root = modelsDir.getCanonicalFile();
                if (!f.getPath().startsWith(root.getPath() + File.separator) || !f.isFile()) {
                    writeNotFound(out);
                    return;
                }
                serveFile(out, f, mimeOf(f.getName()));
                return;
            }

            // Serve bundled APK assets/web/*
            String assetRel = "/".equals(path) ? "index.html" : sanitize(path.substring(1));
            if (assetRel == null) { writeNotFound(out); return; }
            serveAsset(out, "web/" + assetRel, mimeOf(assetRel));
        } catch (Exception ignored) {
        }
    }

    private void serveAsset(OutputStream out, String assetPath, String mime) throws IOException {
        AssetManager am = context.getAssets();
        try (InputStream is = am.open(assetPath)) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
            byte[] data = baos.toByteArray();
            writeStatus(out, 200, "OK", mime, data.length);
            out.write(data);
            out.flush();
        } catch (IOException e) {
            writeNotFound(out);
        }
    }

    private void serveFile(OutputStream out, File f, String mime) throws IOException {
        long len = f.length();
        writeStatus(out, 200, "OK", mime, len);
        try (InputStream is = new BufferedInputStream(new FileInputStream(f))) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
        }
        out.flush();
    }

    private static void writeStatus(OutputStream out, int code, String msg, String mime, long len) throws IOException {
        String h = "HTTP/1.1 " + code + " " + msg + "\r\n"
                + "Content-Type: " + mime + "\r\n"
                + "Content-Length: " + len + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.US_ASCII));
    }

    private static void writeNotFound(OutputStream out) throws IOException {
        byte[] b = "Not Found".getBytes(StandardCharsets.UTF_8);
        writeStatus(out, 404, "Not Found", "text/plain; charset=utf-8", b.length);
        out.write(b);
        out.flush();
    }

    private static String sanitize(String rel) {
        if (rel == null || rel.isEmpty()) return null;
        String clean = rel.replace('\\', '/');
        while (clean.startsWith("/")) clean = clean.substring(1);
        if (clean.contains("..") || clean.isEmpty()) return null;
        return clean;
    }

    private static String mimeOf(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
