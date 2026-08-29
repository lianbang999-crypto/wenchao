package org.foyue.wenchao;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.Locale;
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

    /** 系统朗读引擎。初始化是异步的，就绪前 ttsAvailable() 一律回 false。 */
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;

    NativeBridge(Activity act, WebView web) {
        this.act = act;
        this.web = web;
        this.updater = new ContentUpdater(act);
        initTts();
    }

    /**
     * 接上系统的 TextToSpeech。
     *
     * <p>为什么非做不可：Android WebView 并不实现 Web Speech API 的语音合成部分——
     * 坑在于 {@code 'speechSynthesis' in window} 仍然为真，getVoices() 却是空的、
     * speak() 静默失败、onend 永不触发。页面那边看不出区别，表现就是「点了朗读没反应」，
     * 而且高清朗读失败后降级到本机也一样没声。原先是 TWA、由 Chrome 渲染才没这问题，
     * 换成自建 WebView 后就露出来了。所以本机朗读必须走系统 TTS。
     */
    private void initTts() {
        try {
            tts = new TextToSpeech(act.getApplicationContext(), new TextToSpeech.OnInitListener() {
                @Override public void onInit(int status) {
                    if (status != TextToSpeech.SUCCESS || tts == null) return;
                    int r;
                    try {
                        r = tts.setLanguage(Locale.CHINA);
                    } catch (Exception e) {
                        return;
                    }
                    // 没装中文语音包的机器就别硬读了，让页面走高清（联网）那条路
                    if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) return;
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override public void onStart(String id) { }
                        @Override public void onDone(String id) { ttsCallback(id, true, null); }
                        @Override public void onError(String id) { ttsCallback(id, false, "朗读失败"); }
                        @Override public void onError(String id, int code) { ttsCallback(id, false, "朗读失败"); }
                    });
                    ttsReady = true;
                }
            });
        } catch (Exception ignored) {
            // 取不到引擎就当没有，页面会据此隐藏/降级，不影响阅读
        }
    }

    private void ttsCallback(String id, boolean ok, String err) {
        JSONObject r = new JSONObject();
        put(r, "ok", ok);
        if (err != null) put(r, "error", err);
        callback(id, r);
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

    // —— 本机朗读（替代 WebView 里形同虚设的 speechSynthesis）——

    /** 系统朗读是否可用。初始化异步，页面每次朗读前都该问一次，不要缓存结果。 */
    @JavascriptInterface
    public boolean ttsAvailable() {
        return ttsReady && tts != null;
    }

    /**
     * 读一段话。读完（或出错）经回调通知页面，页面据此接着读下一句。
     * 用 QUEUE_FLUSH：页面是逐句送过来的，上一句没读完就来新的，说明用户已经跳走了。
     */
    @JavascriptInterface
    public void ttsSpeak(String text, float rate, String cbId) {
        if (!ttsAvailable() || text == null || text.isEmpty()) {
            ttsCallback(cbId, false, "本机朗读不可用");
            return;
        }
        try {
            tts.setSpeechRate(rate > 0 ? rate : 1.0f);
            Bundle params = new Bundle();
            // utteranceId 直接用回调号，读完就能对上是哪一句
            int r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, cbId);
            if (r != TextToSpeech.SUCCESS) ttsCallback(cbId, false, "朗读启动失败");
        } catch (Exception e) {
            ttsCallback(cbId, false, "朗读失败");
        }
    }

    @JavascriptInterface
    public void ttsStop() {
        try {
            if (tts != null) tts.stop();
        } catch (Exception ignored) { }
    }

    // —— 分享卡：存相册 / 发给其它应用 ——
    //
    // 页面那套做法在 WebView 里都不成立：<a download> 不会触发下载（WebView 默认不处理
    // 下载，除非另装 DownloadListener），navigator.share 压根不存在，长按图片也没有
    // Chrome 那个「保存图片/分享」上下文菜单。所以这两件事只能落到原生来做。

    /** 存进系统相册。data 是 canvas.toDataURL() 的结果。 */
    @JavascriptInterface
    public void saveImage(final String dataUrl, final String name, final String cbId) {
        pool.execute(new Runnable() {
            @Override public void run() {
                JSONObject r = new JSONObject();
                try {
                    byte[] png = decodeDataUrl(dataUrl);
                    String file = safeName(name) + ".png";
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        // Android 10 起走 MediaStore，落在「图片/印祖文钞」下，不需要任何权限
                        ContentValues cv = new ContentValues();
                        cv.put(MediaStore.Images.Media.DISPLAY_NAME, file);
                        cv.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                        cv.put(MediaStore.Images.Media.RELATIVE_PATH,
                                Environment.DIRECTORY_PICTURES + "/印祖文钞");
                        ContentResolver cr = act.getContentResolver();
                        Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                        if (uri == null) throw new Exception("相册不可写");
                        OutputStream out = cr.openOutputStream(uri);
                        if (out == null) throw new Exception("相册不可写");
                        try { out.write(png); out.flush(); } finally { out.close(); }
                        put(r, "ok", true);
                    } else {
                        // Android 9 及以下写公共目录要 WRITE_EXTERNAL_STORAGE 运行时权限。
                        // 不在这里拉权限弹窗打断用户——直说存不了，让他改用「分享」，
                        // 分享走 FileProvider，任何版本都不需要权限。
                        put(r, "ok", false);
                        put(r, "error", "本系统版本无法直接存相册，请改用「分享」发给微信或相册");
                    }
                } catch (Exception e) {
                    put(r, "ok", false);
                    put(r, "error", "保存失败：" + shortMsg(e));
                }
                callback(cbId, r);
            }
        });
    }

    /** 交给系统分享面板（微信、QQ、相册……）。全版本可用，不需要存储权限。 */
    @JavascriptInterface
    public void shareImage(final String dataUrl, final String name, final String cbId) {
        pool.execute(new Runnable() {
            @Override public void run() {
                JSONObject r = new JSONObject();
                try {
                    byte[] png = decodeDataUrl(dataUrl);
                    File dir = new File(act.getCacheDir(), "share");
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("建不了缓存目录");
                    File f = new File(dir, safeName(name) + ".png");
                    FileOutputStream out = new FileOutputStream(f);
                    try { out.write(png); out.flush(); } finally { out.close(); }

                    Uri uri = FileProvider.getUriForFile(
                            act, act.getPackageName() + ".fileprovider", f);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("image/png");
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(send, "分享法布施卡");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(chooser);
                    put(r, "ok", true);
                } catch (Exception e) {
                    put(r, "ok", false);
                    put(r, "error", "分享失败：" + shortMsg(e));
                }
                callback(cbId, r);
            }
        });
    }

    /** 把 data:image/png;base64,xxx 还原成字节。 */
    private static byte[] decodeDataUrl(String dataUrl) throws Exception {
        if (dataUrl == null) throw new Exception("没有图片数据");
        int comma = dataUrl.indexOf(',');
        String b64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
        byte[] out = Base64.decode(b64, Base64.DEFAULT);
        if (out == null || out.length == 0) throw new Exception("图片数据为空");
        return out;
    }

    /** 文件名消毒：分享卡名字取自篇题，可能带路径分隔符等非法字符。 */
    private static String safeName(String name) {
        String s = (name == null || name.trim().isEmpty()) ? "文钞分享卡" : name.trim();
        s = s.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "");
        return s.length() > 40 ? s.substring(0, 40) : s;
    }

    private static String shortMsg(Exception e) {
        String m = e.getMessage();
        return (m == null || m.isEmpty()) ? e.getClass().getSimpleName() : m;
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

    /** Activity 销毁时释放，交给 MainActivity.onDestroy 调用。 */
    void shutdown() {
        ttsReady = false;
        try {
            if (tts != null) { tts.stop(); tts.shutdown(); }
        } catch (Exception ignored) { }
        tts = null;
        pool.shutdownNow();
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
