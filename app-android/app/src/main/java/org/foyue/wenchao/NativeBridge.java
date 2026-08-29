package org.foyue.wenchao;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 页面与原生之间的桥。
 *
 * <p>页面本身是站点那套代码，在浏览器里跑什么样、在 APP 里就还是什么样；
 * 只有「查更新、装新包」这类事浏览器做不到，才经这里下沉到原生。
 *
 * <p>所有耗时活儿都甩到后台线程，结果经 window.__wcCB(回调号, 结果) 送回页面——
 * JavascriptInterface 的方法是在 WebView 的 JS 线程上被调的，在里面等网络会直接卡死界面。
 *
 * <p>安全性：addJavascriptInterface 会把这些方法暴露给页面里的任何脚本，所以
 * WebView 只加载随包出厂的本地内容（见 MainActivity 的域名限制与外链外跳），
 * 外部网页没有机会跑在这个 WebView 里。
 */
class NativeBridge {

    /** 页面侧的对象名：window.__wcNative */
    static final String NAME = "__wcNative";

    private final Activity act;
    private final WebView web;
    private final ContentUpdater updater;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    NativeBridge(Activity act, WebView web) {
        this.act = act;
        this.web = web;
        this.updater = new ContentUpdater(act);
    }

    // —— 同步的小查询 ——

    /** 外壳版本，用来和站点上的 apkVersion 比对。 */
    @JavascriptInterface
    public String appVersion() {
        return BuildConfig.VERSION_NAME;
    }

    /** 当前内容版本（更新过就是更新后的）。 */
    @JavascriptInterface
    public String contentVersion() {
        try {
            return updater.localManifest().optString("version", "");
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean isOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    act.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Exception e) {
            return false;
        }
    }

    // —— 异步的重活 ——

    /**
     * 查内容更新：拉线上清单比对，回报有多少篇要更新。
     * 结果 {ok, count, version, error}
     */
    @JavascriptInterface
    public void checkUpdate(final String cbId) {
        pool.execute(new Runnable() {
            @Override public void run() {
                JSONObject r = new JSONObject();
                try {
                    JSONObject local = updater.localManifest();
                    JSONObject remote = updater.remoteManifest();
                    List<String> ids = updater.diff(local, remote);
                    boolean books = updater.booksChanged(local, remote);
                    r.put("ok", true);
                    r.put("count", ids.size() + (books ? 1 : 0));
                    r.put("version", remote.optString("version", ""));
                    r.put("current", local.optString("version", ""));
                } catch (Exception e) {
                    put(r, "ok", false);
                    put(r, "error", friendly(e));
                }
                callback(cbId, r);
            }
        });
    }

    /**
     * 下载并应用内容更新。过程中经 window.__wcProgress(已完成, 总数) 报进度。
     * 结果 {ok, count, version, error}
     */
    @JavascriptInterface
    public void applyUpdate(final String cbId) {
        pool.execute(new Runnable() {
            @Override public void run() {
                JSONObject r = new JSONObject();
                try {
                    JSONObject local = updater.localManifest();
                    JSONObject remote = updater.remoteManifest();
                    List<String> ids = updater.diff(local, remote);
                    boolean books = updater.booksChanged(local, remote);
                    if (ids.isEmpty() && !books) {
                        put(r, "ok", true);
                        put(r, "count", 0);
                    } else {
                        updater.apply(ids, books, remote, new ContentUpdater.Progress() {
                            @Override public void onProgress(int done, int total) {
                                evalJs("window.__wcProgress&&window.__wcProgress("
                                        + done + "," + total + ")");
                            }
                        });
                        put(r, "ok", true);
                        put(r, "count", ids.size() + (books ? 1 : 0));
                        put(r, "version", remote.optString("version", ""));
                    }
                } catch (Exception e) {
                    put(r, "ok", false);
                    put(r, "error", friendly(e));
                }
                callback(cbId, r);
            }
        });
    }

    /**
     * 下载新版安装包并唤起系统安装界面。
     * 安装本身由系统接管，成功与否这里管不着，只回报「有没有把包下下来、能不能拉起安装」。
     */
    @JavascriptInterface
    public void installApk(final String url, final String cbId) {
        pool.execute(new Runnable() {
            @Override public void run() {
                JSONObject r = new JSONObject();
                try {
                    // Android 8 起装包要用户单独授权「安装未知应用」，先把人送到那一页
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                            && !act.getPackageManager().canRequestPackageInstalls()) {
                        act.startActivity(new Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + act.getPackageName())));
                        put(r, "ok", false);
                        put(r, "error", "请先允许本应用安装应用，然后再点一次更新");
                        callback(cbId, r);
                        return;
                    }
                    File dir = new File(act.getCacheDir(), "apk");
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("建不了下载目录");
                    File apk = new File(dir, "update.apk");
                    downloadTo(url, apk);

                    Uri uri = FileProvider.getUriForFile(
                            act, act.getPackageName() + ".fileprovider", apk);
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(uri, "application/vnd.android.package-archive");
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(i);
                    put(r, "ok", true);
                } catch (Exception e) {
                    put(r, "ok", false);
                    put(r, "error", friendly(e));
                }
                callback(cbId, r);
            }
        });
    }

    private void downloadTo(String url, File target) throws Exception {
        java.net.HttpURLConnection c =
                (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);      // 安装包 20MB 上下，读超时给宽些
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("下载失败 HTTP " + code);
            int total = c.getContentLength();
            java.io.InputStream in = c.getInputStream();
            java.io.FileOutputStream out = new java.io.FileOutputStream(target);
            try {
                byte[] buf = new byte[16384];
                int n, got = 0;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    if (total > 0) evalJs("window.__wcProgress&&window.__wcProgress("
                            + got + "," + total + ")");
                }
                out.flush();
            } finally {
                try { out.close(); } catch (Exception ignored) { }
                try { in.close(); } catch (Exception ignored) { }
            }
        } finally {
            c.disconnect();
        }
    }

    // —— 回页面 ——

    private void callback(String cbId, JSONObject result) {
        if (cbId == null || cbId.isEmpty()) return;
        // cbId 由页面生成，仍按字面量转义后再拼，避免奇怪的值破坏这段脚本
        evalJs("window.__wcCB&&window.__wcCB(" + JSONObject.quote(cbId)
                + "," + result.toString() + ")");
    }

    private void evalJs(final String js) {
        web.post(new Runnable() {
            @Override public void run() {
                try {
                    web.evaluateJavascript(js, null);
                } catch (Exception ignored) { }
            }
        });
    }

    private static void put(JSONObject o, String k, Object v) {
        try { o.put(k, v); } catch (Exception ignored) { }
    }

    /** 把异常翻成用户看得懂的一句话——「java.net.SocketTimeoutException」对读者没有意义。 */
    private static String friendly(Exception e) {
        if (e instanceof java.net.SocketTimeoutException) return "网络超时，请稍后再试";
        if (e instanceof java.net.UnknownHostException) return "连不上服务器，请检查网络";
        if (e instanceof javax.net.ssl.SSLException) return "网络连接被中断，请稍后再试";
        if (e instanceof java.io.IOException) {
            String m = e.getMessage();
            return m != null && m.startsWith("HTTP ") ? "服务器无响应（" + m + "）" : "网络异常，请稍后再试";
        }
        return "更新失败，请稍后再试";
    }

    /** 未使用，留作扩展：把 id 列表回给页面时用。 */
    @SuppressWarnings("unused")
    private static JSONArray toArray(List<String> list) {
        JSONArray a = new JSONArray();
        for (String s : list) a.put(s);
        return a;
    }
}
