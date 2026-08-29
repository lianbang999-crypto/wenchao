package org.foyue.wenchao;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * 内容的增量更新。
 *
 * <p>经文勘误、白话修订这类改动，只涉及个别篇目（一篇 JSON 平均 8KB），
 * 没道理让人为此重下 20MB 的安装包。所以内容与外壳分两条线走：
 * 内容变了就在 APP 内悄悄补上，只有阅读器本身改版才提示换新包。
 *
 * <p>做法是「出厂内容 + 覆盖层」：APK 里的 assets 只读、永远是出厂那一版；
 * 下载到的新版篇目写进 filesDir/content/，由 {@link AppContentHandler} 优先取用。
 * 这样更新是可叠加的，也永远有一份完好的出厂内容垫底，更新写坏了删掉覆盖层即可复原。
 *
 * <p>所有网络调用都设了超时。这是有教训的：站点的 Service Worker 曾因为
 * fetch 没有超时，遇上「连得上但不回包」的网络就一直挂着，缓存明明有也用不上，
 * 用户看到的就是打不开。凡是等网络的地方，都必须有等不到时的出路。
 */
class ContentUpdater {

    private static final String REMOTE_MANIFEST =
            "https://wenchao.foyue.org/app/content-manifest.json";
    private static final String ASSET_MANIFEST = "content-version.json";
    private static final String STATE_FILE = "content-state.json";

    private static final int CONNECT_TIMEOUT = 10000;
    private static final int READ_TIMEOUT = 15000;
    /** 一次更新最多下这么多篇，防止清单异常时无节制地拉 */
    private static final int MAX_FILES = 3000;

    private final Context ctx;
    private final File overlayDir;

    ContentUpdater(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.overlayDir = new File(this.ctx.getFilesDir(), "content");
    }

    /** 当前生效的内容清单：更新过就用状态文件，否则用随包出厂的那份。 */
    JSONObject localManifest() throws IOException, org.json.JSONException {
        File state = new File(ctx.getFilesDir(), STATE_FILE);
        if (state.isFile()) {
            return new JSONObject(readAll(new java.io.FileInputStream(state)));
        }
        return new JSONObject(readAll(ctx.getAssets().open(ASSET_MANIFEST)));
    }

    JSONObject remoteManifest() throws IOException, org.json.JSONException {
        return new JSONObject(httpGet(REMOTE_MANIFEST));
    }

    /**
     * 比出哪些篇目需要更新。
     * 只看远端有、且本地摘要对不上的；本地多出来的旧篇不动它，
     * 删内容属于罕见操作，不值得为它冒误删的风险。
     */
    List<String> diff(JSONObject local, JSONObject remote) throws org.json.JSONException {
        JSONObject la = local.optJSONObject("articles");
        JSONObject ra = remote.optJSONObject("articles");
        List<String> out = new ArrayList<>();
        if (ra == null) return out;
        for (Iterator<String> it = ra.keys(); it.hasNext(); ) {
            String id = it.next();
            String rh = ra.optString(id, "");
            String lh = la == null ? "" : la.optString(id, "");
            if (!rh.isEmpty() && !rh.equals(lh)) out.add(id);
            if (out.size() >= MAX_FILES) break;
        }
        return out;
    }

    /** 目录（books.json）是否也要换。 */
    boolean booksChanged(JSONObject local, JSONObject remote) {
        String r = remote.optString("books", "");
        return !r.isEmpty() && !r.equals(local.optString("books", ""));
    }

    /**
     * 下载并落盘。全部成功后才写状态文件——中途失败就当这次更新没发生，
     * 已下好的那部分留在覆盖层里也无妨（它们本就是更新的目标内容）。
     */
    void apply(List<String> ids, boolean books, JSONObject remote, Progress cb)
            throws IOException, org.json.JSONException {
        File artDir = new File(overlayDir, "data/articles");
        if (!artDir.isDirectory() && !artDir.mkdirs()) {
            throw new IOException("建不了覆盖层目录：" + artDir);
        }
        int done = 0, total = ids.size() + (books ? 1 : 0);

        if (books) {
            byte[] b = httpGetBytes("https://wenchao.foyue.org/data/books.json");
            writeAtomic(new File(overlayDir, "data/books.json"), b);
            if (cb != null) cb.onProgress(++done, total);
        }
        for (String id : ids) {
            byte[] b = httpGetBytes("https://wenchao.foyue.org/data/articles/" + id + ".json");
            writeAtomic(new File(artDir, id + ".json"), b);
            if (cb != null) cb.onProgress(++done, total);
        }
        // 全下完了才认账：状态文件一写，本地清单就等同远端
        writeAtomic(new File(ctx.getFilesDir(), STATE_FILE),
                remote.toString().getBytes("UTF-8"));
    }

    interface Progress {
        void onProgress(int done, int total);
    }

    // —— 底层工具 ——

    private static String httpGet(String url) throws IOException {
        return new String(httpGetBytes(url), "UTF-8");
    }

    private static byte[] httpGetBytes(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(CONNECT_TIMEOUT);
        c.setReadTimeout(READ_TIMEOUT);
        c.setRequestProperty("Accept-Encoding", "gzip");
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code + " " + url);
            InputStream in = c.getInputStream();
            if ("gzip".equalsIgnoreCase(c.getContentEncoding())) {
                in = new java.util.zip.GZIPInputStream(in);
            }
            return readAllBytes(in);
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        return new String(readAllBytes(in), "UTF-8");
    }

    private static byte[] readAllBytes(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            try { in.close(); } catch (IOException ignored) { }
        }
    }

    /** 先写临时文件再改名：中途断电断网也不会留下半截文件被当成正文读走。 */
    private static void writeAtomic(File target, byte[] data) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("建不了目录：" + parent);
        }
        File tmp = new File(target.getAbsolutePath() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            out.write(data);
            out.flush();
            out.getFD().sync();
        } finally {
            out.close();
        }
        if (target.exists() && !target.delete()) {
            tmp.delete();
            throw new IOException("旧文件删不掉：" + target);
        }
        if (!tmp.renameTo(target)) {
            tmp.delete();
            throw new IOException("改名失败：" + target);
        }
    }
}
