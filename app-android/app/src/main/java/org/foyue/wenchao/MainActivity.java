package org.foyue.wenchao;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;

/**
 * 离线阅读器主界面。
 *
 * <p>这里取代了原先的 TWA 外壳。TWA 本质是「委托 Chrome 打开一个网站」，
 * 架构上没法带本地内容——包里一篇经文都没有，每次打开都得联网现取，
 * 网络一波动就是白屏，而且全屏无地址栏，用户连刷新都点不着。
 * 改成自己的 WebView 后，全部内容随 APK 装进手机，网络只用于检查更新。
 *
 * <p>用 WebViewAssetLoader 把内容挂到 https://appassets.androidplatform.net 这个
 * 本地域下，而不是 file://——后者受同源策略限制，localStorage 与 fetch 都会失效，
 * 阅读设置存不住、篇目取不到。挂在 https 域下则与线上环境一致，站点代码不用改。
 */
public class MainActivity extends Activity {

    /** androidx 约定的本地域名，不会真的走网络 */
    private static final String DOMAIN = "appassets.androidplatform.net";

    /** app.js 会读 ?app= 记下外壳版本，供「我的」页比对是否有新版 */
    private static final String START_URL =
            "https://" + DOMAIN + "/index.html?app=" + BuildConfig.VERSION_NAME;

    /**
     * 阅读器入口是 &lt;script type="module"&gt;，模块脚本要 Chrome 61 才支持。
     * 低于此版本的内核解析不了，页面会静静地什么都不做——与其让人对着白屏，
     * 不如直说是系统组件太旧、该去哪儿更新。
     */
    private static final int MIN_WEBVIEW = 61;

    private WebView web;
    private View splash;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int wv = webViewMajorVersion();
        if (wv > 0 && wv < MIN_WEBVIEW) {
            setContentView(unsupportedView(wv));
            return;
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFFCFAF6);      // 与启动屏同色，避免加载瞬间闪白

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();
        web.loadUrl(START_URL);
    }

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);             // 阅读设置、书签、AI 会话都存在 localStorage
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);              // 内容一律经 AssetLoader 取，不开 file 通道
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);                  // 字号由阅读器自己的设置控制，双指缩放会打架
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);   // 朗读功能要能自动起播
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // 内容全在本地 https 域，用不到混合内容；显式关掉更安全
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN)
                .addPathHandler("/", new AppContentHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleExternal(req.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleExternal(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
            }
        });

        web.addJavascriptInterface(new NativeBridge(this, web), NativeBridge.NAME);
    }

    /**
     * 站外地址交给系统浏览器，别在阅读器里打开。
     * 判据是域名：本地域内的一切属于 APP 自身，其余（返回主站、维基、百度百科等）都往外送。
     */
    private boolean handleExternal(Uri uri) {
        if (uri == null) return false;
        if (DOMAIN.equals(uri.getHost())) return false;     // 自家地址，照常在 WebView 里走
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // 没有可处理的应用就什么都不做，总好过崩掉
        }
        return true;
    }

    private void hideSplash() {
        if (splash == null) return;
        final View s = splash;
        splash = null;
        s.animate().alpha(0f).setDuration(300).withEndAction(new Runnable() {
            @Override public void run() {
                if (s.getParent() instanceof ViewGroup) ((ViewGroup) s.getParent()).removeView(s);
            }
        }).start();
    }

    private View buildSplash() {
        FrameLayout f = new FrameLayout(this);
        f.setBackgroundColor(0xFFFCFAF6);
        ImageView iv = new ImageView(this);
        iv.setImageResource(R.drawable.splash);
        iv.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.CENTER;
        f.addView(iv, lp);
        return f;
    }

    /** 系统 WebView 主版本号；取不到返回 -1（取不到时不拦，让它试着跑）。 */
    private int webViewMajorVersion() {
        try {
            PackageInfo info = WebViewCompat.getCurrentWebViewPackage(this);
            if (info == null || info.versionName == null) return -1;
            String major = info.versionName.split("\\.")[0];
            return Integer.parseInt(major);
        } catch (Exception e) {
            return -1;
        }
    }

    /** 内核过旧时的说明页。用原生控件而非 HTML——这种时候 WebView 本身就不可信。 */
    private View unsupportedView(int ver) {
        TextView t = new TextView(this);
        t.setText("很抱歉，本机的「Android System WebView」系统组件版本过旧（"
                + ver + " 版），无法运行阅读器。\n\n"
                + "请到手机的应用商店搜索「Android System WebView」或「Chrome」并更新，"
                + "之后重新打开本应用即可。\n\n"
                + "也可以直接用手机浏览器访问：\nwenchao.foyue.org");
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        t.setLineSpacing(0f, 1.5f);
        t.setTextColor(Color.parseColor("#171310"));
        t.setBackgroundColor(Color.parseColor("#FCFAF6"));
        int pad = (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, 24, getResources().getDisplayMetrics());
        t.setPadding(pad, pad * 3, pad, pad);
        return t;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface(NativeBridge.NAME);
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
