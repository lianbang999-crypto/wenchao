package org.foyue.wenchao;

import android.content.Context;
import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;

import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * APP 内容的取件台：一个请求进来，按「覆盖层 → 出厂内容 → 兜底首页」三级依次找。
 *
 * <p>为什么要自己写而不直接用 AssetsPathHandler：
 * <ul>
 *   <li><b>增量更新</b>——APK 里的内容是只读的，勘误后不可能改。所以先查
 *       filesDir/content/ 这一层「覆盖层」，那是更新时下载下来的新版篇目；
 *       没有才回落到出厂内容。用户因此不必为改几个字重装 27MB。</li>
 *   <li><b>SPA 回退</b>——阅读器用 pushState 把地址改成 /a/jx-001/，但站点里
 *       那 2565 个实体页没有打进包（46MB，占大头）。正常点击不会请求它们，
 *       可一旦 APP 被系统回收后从该地址恢复，就会真的来取。这时兜到 index.html，
 *       由 app.js 自己解析地址还原到那一篇。</li>
 *   <li><b>目录补全</b>——/v/jy/ 这类地址要落到 /v/jy/index.html。</li>
 * </ul>
 *
 * <p>MIME 必须给准：app.js 是 &lt;script type="module"&gt;，浏览器对模块脚本
 * 做严格 MIME 检查，给错类型会被直接拒绝执行，表现为整个阅读器不动——
 * 这正是要避免的那种「装了却打不开」。
 */
class AppContentHandler implements WebViewAssetLoader.PathHandler {

    private final AssetManager assets;
    /** 增量更新落盘处；出厂时不存在，下过更新才有 */
    private final File overlayDir;

    private static final Map<String, String> MIME;
    static {
        Map<String, String> m = new HashMap<>();
        m.put("html", "text/html");
        m.put("js", "text/javascript");          // 模块脚本必须是 JS MIME，否则不执行
        m.put("mjs", "text/javascript");
        m.put("css", "text/css");
        m.put("json", "application/json");
        m.put("webmanifest", "application/manifest+json");
        m.put("svg", "image/svg+xml");
        m.put("png", "image/png");
        m.put("jpg", "image/jpeg");
        m.put("jpeg", "image/jpeg");
        m.put("gif", "image/gif");
        m.put("webp", "image/webp");
        m.put("ico", "image/x-icon");
        m.put("woff2", "font/woff2");
        m.put("woff", "font/woff");
        m.put("ttf", "font/ttf");
        m.put("txt", "text/plain");
        MIME = Collections.unmodifiableMap(m);
    }

    AppContentHandler(Context ctx) {
        this.assets = ctx.getAssets();
        this.overlayDir = new File(ctx.getFilesDir(), "content");
    }

    @Nullable
    @Override
    public WebResourceResponse handle(String path) {
        String p = normalize(path);

        // 一、覆盖层：增量更新下来的新版内容优先
        File local = new File(overlayDir, p);
        if (isInside(overlayDir, local) && local.isFile()) {
            try {
                return respond(p, new FileInputStream(local));
            } catch (IOException ignored) {
                // 覆盖层坏了不是致命的，继续往下回落到出厂内容
            }
        }

        // 二、出厂内容
        InputStream in = openAsset(p);
        if (in != null) return respond(p, in);

        // 三、SPA 回退：只对「看起来是页面」的地址兜底。
        //    静态资源（.json/.css/.woff2…）取不到就该老实报 404，
        //    否则 fetch 会拿到一份 HTML，反而把错误藏起来、更难查。
        if (looksLikePage(p)) {
            InputStream home = openAsset("index.html");
            if (home != null) return respond("index.html", home);
        }
        return null;   // 交回 WebView，按常规 404 处理
    }

    /** 去掉前导斜杠；目录地址补 index.html。 */
    private static String normalize(String path) {
        String p = path.startsWith("/") ? path.substring(1) : path;
        if (p.isEmpty()) return "index.html";
        if (p.endsWith("/")) return p + "index.html";
        return p;
    }

    /** 无扩展名、或以 .html 结尾的，视为页面地址。 */
    private static boolean looksLikePage(String p) {
        int slash = p.lastIndexOf('/');
        String last = slash >= 0 ? p.substring(slash + 1) : p;
        int dot = last.lastIndexOf('.');
        return dot < 0 || last.endsWith(".html");
    }

    @Nullable
    private InputStream openAsset(String p) {
        try {
            return assets.open(p, AssetManager.ACCESS_STREAMING);
        } catch (IOException e) {
            return null;    // assets 里没有这一份
        }
    }

    private static WebResourceResponse respond(String path, InputStream data) {
        String mime = mimeOf(path);
        // 文本类显式声明 UTF-8：经文正文全是中文，缺了这一项会整篇乱码
        String enc = mime.startsWith("text/") || mime.contains("json")
                || mime.contains("javascript") || mime.contains("manifest") ? "utf-8" : null;
        WebResourceResponse r = new WebResourceResponse(mime, enc, data);
        // 本地内容不涉及跨源，给一条宽松的 CORS 头即可，省得 fetch 被拦
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-cache");
        r.setResponseHeaders(headers);
        return r;
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "text/html";
        String ext = path.substring(dot + 1).toLowerCase();
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    /** 防目录穿越：覆盖层的路径来自网络下载的清单，必须确认它没跑出沙箱。 */
    private static boolean isInside(File dir, File child) {
        try {
            return child.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator);
        } catch (IOException e) {
            return false;
        }
    }
}
