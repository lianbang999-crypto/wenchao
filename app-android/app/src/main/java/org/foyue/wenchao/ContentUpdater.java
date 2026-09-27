package org.foyue.wenchao;

import android.content.Context;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;

/**
 * 内容的增量更新。
 *
 * <p>经文勘误、白话修订这类改动，只涉及个别篇目（一篇 JSON 平均 8KB），
 * 没道理让人为此重下 20MB 的安装包。所以内容与外壳分两条线走：
 * 内容变了就在 APP 内悄悄补上，只有阅读器本身改版才提示换新包。
 *
 * <p>做法是「出厂内容 + 覆盖层」：APK 里的 assets 只读、永远是出厂那一版；
 * 下载到的新版篇目先写进一个不可变的暂存目录，全部校验通过后再用
 * content-state.json 一次性切换生效目录。APK 始终保留完好的出厂内容。
 *
 * <p>所有网络调用都设了超时。这是有教训的：站点的 Service Worker 曾因为
 * fetch 没有超时，遇上「连得上但不回包」的网络就一直挂着，缓存明明有也用不上，
 * 用户看到的就是打不开。凡是等网络的地方，都必须有等不到时的出路。
 */
class ContentUpdater {

    private static final String SITE = "https://wenchao.foyue.org";
    private static final String ASSET_MANIFEST = "content-version.json";
    static final String STATE_FILE = "content-state.json";
    private static final String GENERATION_FIELD = "_overlayGeneration";
    private static final String GENERATIONS_DIR = "content-generations";

    private static final int CONNECT_TIMEOUT = 10000;
    private static final int READ_TIMEOUT = 15000;
    /** 一次更新最多下这么多篇，防止清单异常时无节制地拉 */
    private static final int MAX_FILES = 3000;
    private static final int MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
    private static final int MAX_CONTENT_BYTES = 5 * 1024 * 1024;

    private final Context ctx;
    private final String site;
    private final File dataRoot;

    ContentUpdater(Context ctx) {
        this(ctx, SITE, ctx.getFilesDir());
    }

    /** Package-private override keeps transaction tests entirely on localhost. */
    ContentUpdater(Context ctx, String site, File dataRoot) {
        this.ctx = ctx.getApplicationContext();
        this.site = site;
        this.dataRoot = dataRoot;
    }

    /** 当前生效的内容清单：更新过就用状态文件，否则用随包出厂的那份。 */
    JSONObject localManifest() throws IOException, org.json.JSONException {
        File state = new File(dataRoot, STATE_FILE);
        try {
            JSONObject saved = new JSONObject(readAll(new AtomicFile(state).openRead()));
            validateManifest(saved);
            return saved;
        } catch (IOException | org.json.JSONException ignored) {
            // AtomicFile may recover a valid backup even if the base file is
            // absent. Otherwise the immutable APK is the safe fallback.
        }
        return new JSONObject(readAll(ctx.getAssets().open(ASSET_MANIFEST)));
    }

    JSONObject remoteManifest() throws IOException, org.json.JSONException {
        JSONObject remote = new JSONObject(httpGet(site + "/app/content-manifest.json"));
        validateManifest(remote);
        return remote;
    }

    /** Generated timestamps are fixed-width UTC values; older manifests must not undo bundled fixes. */
    static boolean remoteOlder(JSONObject local, JSONObject remote) {
        String current = local.optString("generated", "");
        String incoming = remote.optString("generated", "");
        return validGenerated(current) && validGenerated(incoming)
                && incoming.compareTo(current) < 0;
    }

    /** The state file is the only publication pointer; incomplete generations are invisible. */
    static File activeOverlayDir(File root) {
        File state = new File(root, STATE_FILE);
        try {
            JSONObject manifest = new JSONObject(readAll(new AtomicFile(state).openRead()));
            String generation = manifest.optString(GENERATION_FIELD, "");
            if (generation.isEmpty()) {
                // Migration path for installations updated by releases before 1.1.4.
                File legacy = new File(root, "content");
                return legacy.isDirectory() ? legacy : null;
            }
            if (!generation.matches("[A-Za-z0-9_-]{1,80}")) return null;
            File current = new File(new File(root, GENERATIONS_DIR), generation);
            return current.isDirectory() ? current : null;
        } catch (Exception ignored) {
            return null;
        }
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
     * 比出哪些前端资源（js/css）要更新。
     *
     * <p>把这些也纳进来，是为了让阅读器本身的修补也能增量下发——否则改一行 JS 就得
     * 让所有人重下二十多兆的安装包，「内容增量、外壳换包」这个分工就名存实亡了。
     * 只有原生那部分（Java）改动才是真正非换包不可的。
     *
     * <p>可行的前提是取件台按路径找、忽略查询串：覆盖层放一份 js/app.js 就会盖住
     * 随包出厂的那份，页面里 ?v=xxx 写的是什么都不影响命中。
     */
    List<String> diffAssets(JSONObject local, JSONObject remote) {
        JSONObject la = local.optJSONObject("assets");
        JSONObject ra = remote.optJSONObject("assets");
        List<String> out = new ArrayList<>();
        if (ra == null) return out;
        for (Iterator<String> it = ra.keys(); it.hasNext(); ) {
            String path = it.next();
            String rh = ra.optString(path, "");
            String lh = la == null ? "" : la.optString(path, "");
            if (!rh.isEmpty() && !rh.equals(lh)) out.add(path);
            if (out.size() >= MAX_FILES) break;
        }
        return out;
    }

    /**
     * Build an immutable, verified overlay generation before publishing its
     * pointer. A failed download, bad 200 response or process death can leave
     * an unused staging directory, but cannot change any active article/script.
     */
    int apply(JSONObject remote, Progress cb) throws IOException, org.json.JSONException {
        validateManifest(remote);
        if (remoteOlder(localManifest(), remote)) {
            throw new IOException("线上内容版本早于本机，暂不覆盖");
        }
        JSONObject bundled = new JSONObject(readAll(ctx.getAssets().open(ASSET_MANIFEST)));
        List<Target> targets = targetsNotInBundle(remote, bundled);
        String generation = "g-" + UUID.randomUUID().toString();
        File generations = new File(dataRoot, GENERATIONS_DIR);
        File stage = new File(generations, generation);
        if (!stage.mkdirs()) throw new IOException("建不了更新暂存目录");
        File previous = activeOverlayDir(dataRoot);
        boolean published = false;
        int downloaded = 0;
        try {
            for (int i = 0; i < targets.size(); i++) {
                Target target = targets.get(i);
                byte[] data = null;
                if (previous != null) {
                    File old = new File(previous, target.path);
                    if (inside(previous, old) && old.isFile() && old.length() <= MAX_CONTENT_BYTES) {
                        data = readAllBytes(new java.io.FileInputStream(old), MAX_CONTENT_BYTES);
                        if (!digestMatches(data, target.hash) || !validDocument(target.path, data)) {
                            data = null;
                        }
                    }
                }
                if (data == null) {
                    String cacheBuster = target.path.startsWith("js/") || target.path.startsWith("css/")
                            ? "?h=" + target.hash : "";
                    data = httpGetBytes(site + "/" + target.path + cacheBuster, MAX_CONTENT_BYTES);
                    if (!digestMatches(data, target.hash) || !validDocument(target.path, data)) {
                        throw new IOException("下载内容校验失败：" + target.path);
                    }
                    downloaded++;
                }
                writeFile(new File(stage, target.path), data);
                if (cb != null) cb.onProgress(i + 1, targets.size());
            }
            JSONObject state = new JSONObject(remote.toString());
            state.put(GENERATION_FIELD, generation);
            writeAtomic(new File(dataRoot, STATE_FILE), state.toString().getBytes("UTF-8"));
            published = true;
            return downloaded;
        } finally {
            if (!published) deleteTree(stage);
        }
    }

    private static final class Target {
        final String path;
        final String hash;
        Target(String path, String hash) { this.path = path; this.hash = hash; }
    }

    private static List<Target> targetsNotInBundle(JSONObject remote, JSONObject bundled) {
        List<Target> targets = new ArrayList<>();
        if (!remote.optString("books", "").equals(bundled.optString("books", ""))) {
            targets.add(new Target("data/books.json", remote.optString("books")));
        }
        addTargets(targets, remote.optJSONObject("articles"), bundled.optJSONObject("articles"),
                "data/articles/", ".json");
        addTargets(targets, remote.optJSONObject("assets"), bundled.optJSONObject("assets"), "", "");
        return targets;
    }

    private static void addTargets(List<Target> out, JSONObject remote, JSONObject bundled,
                                   String prefix, String suffix) {
        if (remote == null) return;
        for (Iterator<String> it = remote.keys(); it.hasNext(); ) {
            String name = it.next();
            String hash = remote.optString(name, "");
            if (bundled == null || !hash.equals(bundled.optString(name, ""))) {
                out.add(new Target(prefix + name + suffix, hash));
            }
        }
    }

    private static void validateManifest(JSONObject remote) throws IOException {
        JSONObject articles = remote.optJSONObject("articles");
        JSONObject assets = remote.optJSONObject("assets");
        if (articles == null || assets == null || articles.length() > MAX_FILES
                || assets.length() > MAX_FILES || !validHash(remote.optString("books", ""))
                || !validGenerated(remote.optString("generated", ""))) {
            throw new IOException("更新清单格式错误");
        }
        for (Iterator<String> it = articles.keys(); it.hasNext(); ) {
            String id = it.next();
            if (!id.matches("[A-Za-z0-9-]{1,80}") || !validHash(articles.optString(id, ""))) {
                throw new IOException("更新清单篇目无效");
            }
        }
        for (Iterator<String> it = assets.keys(); it.hasNext(); ) {
            String path = it.next();
            if (!safeRelPath(path) || !validHash(assets.optString(path, ""))) {
                throw new IOException("更新清单资源无效");
            }
        }
    }

    private static boolean validHash(String hash) { return hash.matches("[0-9a-f]{12}"); }

    private static boolean validGenerated(String value) {
        return value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z");
    }

    private static boolean digestMatches(byte[] data, String expected) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] digest = md.digest(data);
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 6; i++) hex.append(String.format(java.util.Locale.ROOT, "%02x", digest[i] & 0xff));
            return hex.toString().equals(expected);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("缺少内容校验算法", e);
        }
    }

    private static boolean validDocument(String path, byte[] data) {
        if (!path.startsWith("data/") || !path.endsWith(".json")) return true;
        try {
            String json = new String(data, "UTF-8");
            if ("data/books.json".equals(path)) return new JSONArray(json).length() > 0;
            JSONObject article = new JSONObject(json);
            String id = path.substring("data/articles/".length(), path.length() - 5);
            return id.equals(article.optString("id")) && article.optJSONArray("segments") != null;
        } catch (Exception ignored) { return false; }
    }

    private static boolean inside(File root, File child) throws IOException {
        return child.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator);
    }

    /** 只收 js/ css/ 下的普通相对路径，挡住 ../ 之类越界写入。 */
    private static boolean safeRelPath(String p) {
        if (p == null || p.isEmpty() || p.contains("..") || p.startsWith("/")) return false;
        return p.matches("(?:js|css)/[A-Za-z0-9_.-]{1,120}") && !p.contains("..");
    }

    interface Progress {
        void onProgress(int done, int total);
    }

    // —— 底层工具 ——

    private static String httpGet(String url) throws IOException {
        return new String(httpGetBytes(url, MAX_MANIFEST_BYTES), "UTF-8");
    }

    private static byte[] httpGetBytes(String url, int limit) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(CONNECT_TIMEOUT);
        c.setReadTimeout(READ_TIMEOUT);
        c.setRequestProperty("Accept-Encoding", "gzip");
        c.setInstanceFollowRedirects(false);
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code + " " + url);
            InputStream in = c.getInputStream();
            if ("gzip".equalsIgnoreCase(c.getContentEncoding())) {
                in = new java.util.zip.GZIPInputStream(in);
            }
            return readAllBytes(in, limit);
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        return new String(readAllBytes(in, MAX_MANIFEST_BYTES), "UTF-8");
    }

    private static byte[] readAllBytes(InputStream in) throws IOException {
        return readAllBytes(in, MAX_CONTENT_BYTES);
    }

    private static byte[] readAllBytes(InputStream in, int limit) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (out.size() > limit - n) throw new IOException("下载内容过大");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            try { in.close(); } catch (IOException ignored) { }
        }
    }

    /** State pointer commit uses Android's AtomicFile backup/restore protocol. */
    private static void writeAtomic(File target, byte[] data) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("建不了目录：" + parent);
        }
        AtomicFile atomic = new AtomicFile(target);
        FileOutputStream out = atomic.startWrite();
        try {
            out.write(data);
            atomic.finishWrite(out);
        } catch (IOException e) {
            atomic.failWrite(out);
            throw e;
        }
    }

    private static void writeFile(File target, byte[] data) throws IOException {
        File parent = target.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("建不了暂存目录");
        FileOutputStream out = new FileOutputStream(target);
        try {
            out.write(data);
            out.getFD().sync();
        } finally {
            out.close();
        }
    }

    private static void deleteTree(File path) {
        if (path.isDirectory()) {
            File[] children = path.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        path.delete();
    }
}
