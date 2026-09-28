package org.foyue.wenchao;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Dependency-free smoke test of the installed APK and its real platform WebView.
 * Run on a disposable API 19 or modern emulator. The default suite never
 * checks online update services. The optional -e update offline|online
 * exercises only the read-only checkUpdate path, never apply/install:
 * adb shell am instrument -w -r org.foyue.wenchao.test/org.foyue.wenchao.CompatibilitySmokeTest
 * Success: INSTRUMENTATION_CODE: 0, ok=true. Failure: code 1 and a failing step.
 * Keep -r: older Android versions show only stream output without raw-result mode.
 * Android's am command does not consistently propagate this code to its shell exit code.
 * No JavaScript test doubles, network responses, or app functions are substituted.
 */
public final class CompatibilitySmokeTest extends Instrumentation {
    private static final String ARTICLE = "jx-051";
    private final ArrayList<String> steps = new ArrayList<>();
    private Activity activity;
    private WebView web;
    private String step = "launch";
    private String updateMode = "";
    private String searchMode = "";

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        if (arguments != null) {
            updateMode = arguments.getString("update", "");
            searchMode = arguments.getString("search", "");
        }
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        int code = 0;
        try {
            Intent launch = new Intent();
            launch.setClassName(getTargetContext().getPackageName(),
                    "org.foyue.wenchao.MainActivity");
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            activity = startActivitySync(launch);
            runOnMainSync(new Runnable() {
                @Override public void run() {
                    web = findWebView(activity.getWindow().getDecorView());
                }
            });
            check(web != null, "MainActivity did not create a WebView");
            await("document.readyState === 'complete'", 30000);
            String url = String.valueOf(js("location.href"));
            result.putString("url", url);
            result.putInt("sdk", Build.VERSION.SDK_INT);
            result.putString("userAgent", String.valueOf(js("navigator.userAgent")));
            if (Build.VERSION.SDK_INT < 21) {
                check(url.contains("/legacy.html"), "API 19 must automatically select legacy.html");
            }
            if (!searchMode.isEmpty()) {
                check("online".equals(searchMode) && !url.contains("/legacy.html"),
                        "Optional online search needs the modern reader");
                testOnlineScopedSearch();
            } else if (url.contains("/legacy.html")) {
                check(updateMode.isEmpty(), "Optional update checks require the modern reader UI");
                runLegacy();
            } else runModern();
            if (updateMode.isEmpty() && searchMode.isEmpty()) {
                // Internal Java classes are obfuscated in the signed release.
                // UI checks run against that actual release; the white-box
                // transaction and signature guards run against debug builds.
                boolean debugTarget = (getTargetContext().getApplicationInfo().flags
                        & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
                if (debugTarget) {
                    // The release app deliberately disallows cleartext traffic
                    // on Android 9+. The localhost HTTP fixture uses API 19–27.
                    if (Build.VERSION.SDK_INT < 28) {
                        step = "content update transaction";
                        ContentUpdaterTransactionTest.run(getTargetContext());
                        pass();
                    } else {
                        steps.add("DIAG loopback transaction fixture runs on API 19–27");
                    }
                    testApkUpdateSecurity();
                } else {
                    steps.add("DIAG release UI verified; internal guards are tested in debug build");
                }
            }
            result.putBoolean("ok", true);
            result.putInt("failures", 0);
        } catch (Throwable failure) {
            code = 1;
            result.putBoolean("ok", false);
            result.putInt("failures", 1);
            result.putString("failedStep", step);
            result.putString("error", failure.toString());
            steps.add("FAIL " + step + ": " + failure);
        } finally {
            if (activity != null) {
                runOnMainSync(new Runnable() {
                    @Override public void run() { activity.finish(); }
                });
            }
        }
        result.putStringArrayList("steps", steps);
        StringBuilder stream = new StringBuilder("\n");
        for (String entry : steps) stream.append(entry).append('\n');
        result.putString("stream", stream.toString());
        finish(code, result);
    }

    private void runLegacy() throws Exception {
        step = "legacy catalog and all 2565 entries";
        await("!!document.getElementById('legacy-page')", 30000);
        JSONArray books = new JSONArray(asset("data/books.json"));
        List<String> expectedIds = catalogIds(books);
        check(expectedIds.size() == 2565, "Unexpected bundled corpus count");
        int pages = number(js("document.getElementById('legacy-page').options.length"));
        check(pages == 43, "Expected 43 catalog pages at 60 entries per page");
        check(number(js("document.querySelectorAll('#legacy-volumes [data-vol]').length"))
                == books.length(), "Volume buttons do not match the bundled catalog");
        List<String> actualIds = new ArrayList<>();
        for (int page = 0; page < pages; page++) {
            select("legacy-page", String.valueOf(page));
            JSONArray ids = (JSONArray) js("(function(){var a=[],n=document.querySelectorAll(" +
                    "'#legacy-results [data-id]');for(var i=0;i<n.length;i++)" +
                    "a.push(n[i].getAttribute('data-id'));return a;}())");
            check(ids.length() == (page == 42 ? 45 : 60), "Incorrect page size on page " + page);
            for (int i = 0; i < ids.length(); i++) actualIds.add(ids.getString(i));
        }
        check(actualIds.equals(expectedIds), "Catalog paging dropped, repeated, or reordered entries");
        pass();

        step = "title search and volume selection";
        select("legacy-volume", "jx");
        check(number(js("document.querySelectorAll('#legacy-results [data-id]').length")) == 60,
                "Volume selection did not reset pagination");
        input("legacy-search", "一函遍复");
        await("document.querySelectorAll('#legacy-results [data-id]').length === 1", 5000);
        check(ARTICLE.equals(js("document.querySelector('#legacy-results [data-id]').getAttribute('data-id')")),
                "Title search found the wrong article");
        pass();

        step = "XHR article load: original, translation, and notes";
        JSONObject article = new JSONObject(asset("data/articles/" + ARTICLE + ".json"));
        click("#legacy-results [data-id='" + ARTICLE + "']");
        await("location.hash === '#article=" + ARTICLE + "' && !!document.getElementById('legacy-body')", 20000);
        click("[data-mode='both']");
        check(article.getString("title").equals(js("document.querySelector('.legacy-article h1').textContent")),
                "Opened article title does not match its bundled JSON");
        compareText("#legacy-body .legacy-original", paragraphs(article, "orig"));
        compareText("#legacy-body .legacy-translation", paragraphs(article, "trans"));
        List<String> expectedNotes = new ArrayList<>();
        JSONArray segments = article.getJSONArray("segments");
        for (int i = 0; i < segments.length(); i++) {
            JSONArray notes = segments.getJSONObject(i).optJSONArray("notes");
            if (notes == null) continue;
            for (int j = 0; j < notes.length(); j++) expectedNotes.add(notes.getJSONObject(j).getString("text"));
        }
        check(!expectedNotes.isEmpty(), "Smoke article must exercise notes");
        compareText("#legacy-body .legacy-notes li p", expectedNotes);
        pass();

        step = "original / translation / parallel mode controls";
        click("[data-mode='orig']");
        check(number(js("document.querySelectorAll('.legacy-translation').length")) == 0,
                "Original mode still shows translations");
        compareText("#legacy-body .legacy-original", paragraphs(article, "orig"));
        click("[data-mode='trans']");
        check(number(js("document.querySelectorAll('.legacy-original').length")) == 0,
                "Translation mode still shows original paragraphs");
        compareText("#legacy-body .legacy-translation", paragraphs(article, "trans"));
        click("[data-mode='both']");
        compareText("#legacy-body .legacy-original", paragraphs(article, "orig"));
        compareText("#legacy-body .legacy-translation", paragraphs(article, "trans"));
        pass();

        step = "font size control";
        int before = number(js("parseInt(document.getElementById('legacy-body').style.fontSize,10)"));
        click(before < 28 ? "#legacy-larger" : "#legacy-smaller");
        int after = number(js("parseInt(document.getElementById('legacy-body').style.fontSize,10)"));
        check(after == before + (before < 28 ? 1 : -1), "Font control did not change the rendered size");
        check(number(js("JSON.parse(localStorage.getItem('wc.legacy.size'))")) == after,
                "Font size was not saved");
        pass();

        step = "scroll position saved when immediately leaving article";
        js("(function(){window.scrollTo(0,1200);return true;}())");
        await("window.pageYOffset > 500", 5000);
        double scroll = ((Number) js("window.pageYOffset")).doubleValue();
        click("#legacy-home");
        await("!!document.getElementById('legacy-resume')", 5000);
        JSONObject saved = (JSONObject) js("JSON.parse(localStorage.getItem('wc.legacy.position." + ARTICLE + "'))");
        check(Math.abs(saved.getDouble("y") - scroll) <= 2,
                "Leaving the article lost its scroll position: actualSavedY=" +
                        saved.getDouble("y") + ", originalScroll=" + scroll);
        check(ARTICLE.equals(js("JSON.parse(localStorage.getItem('wc.legacy.last')).id")),
                "Last-read article was not saved");
        pass();

        step = "resume after a real WebView reload";
        js("(function(){window.__compatSmokeReloadMarker=true;return true;}())");
        runOnMainSync(new Runnable() {
            @Override public void run() { web.reload(); }
        });
        await("!window.__compatSmokeReloadMarker && document.readyState === 'complete' && !!document.getElementById('legacy-resume')", 20000);
        click("#legacy-resume");
        await("location.hash === '#article=" + ARTICLE + "' && !!document.getElementById('legacy-body') && window.pageYOffset > 500", 20000);
        double restored = ((Number) js("window.pageYOffset")).doubleValue();
        check(Math.abs(restored - scroll) <= 3,
                "Resume did not restore the actual scroll offset: restoredY=" +
                        restored + ", originalScroll=" + scroll);
        compareText("#legacy-body .legacy-original", paragraphs(article, "orig"));
        pass();

        step = "adjacent article navigation";
        String next = String.valueOf(js("document.querySelector('.legacy-pager [data-id=\"jx-052\"]').getAttribute('data-id')"));
        click(".legacy-pager [data-id='" + next + "']");
        await("location.hash === '#article=" + next + "' && document.querySelector('.legacy-article h1') && " +
                "document.querySelector('.legacy-article h1').textContent === " +
                JSONObject.quote(new JSONObject(asset("data/articles/" + next + ".json")).getString("title")), 20000);
        pass();

        step = "Android back key restores the previous article and reading position";
        sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        await("location.hash === '#article=" + ARTICLE + "' && document.querySelector('.legacy-article h1') && " +
                "document.querySelector('.legacy-article h1').textContent === " +
                JSONObject.quote(article.getString("title")), 20000);
        double backY = ((Number) js("window.pageYOffset")).doubleValue();
        check(Math.abs(backY - scroll) <= 3,
                "Android back key lost the reading position: restoredY=" + backY +
                        ", originalScroll=" + scroll);
        compareText("#legacy-body .legacy-original", paragraphs(article, "orig"));
        pass();
    }

    private void testApkUpdateSecurity() throws Exception {
        step = "APK update URL and signature guards";
        check("wenchao.foyue.org".equals(NativeBridge.checkedApkUrl(
                "/app/wenchao-1.1.4.apk").getHost()), "Official relative APK URL was rejected");
        check("wenchao.foyue.org".equals(NativeBridge.checkedApkUrl(
                "https://wenchao.foyue.org/app/wenchao-1.1.4.apk").getHost()),
                "Official absolute APK URL was rejected");
        String[] unsafe = {
                "http://wenchao.foyue.org/app/wenchao-1.1.4.apk",
                "https://wenchao.foyue.org.evil.test/app/wenchao-1.1.4.apk",
                "https://evil.test@wenchao.foyue.org/app/wenchao-1.1.4.apk",
                "https://wenchao.foyue.org:444/app/wenchao-1.1.4.apk",
                "https://wenchao.foyue.org/app/../app/wenchao-1.1.4.apk",
                "https://wenchao.foyue.org/app/wenchao-1.1.4.apk?redirect=1",
                "//evil.test/app/wenchao-1.1.4.apk"
        };
        for (String url : unsafe) {
            boolean rejected = false;
            try { NativeBridge.checkedApkUrl(url); }
            catch (Exception expected) { rejected = true; }
            check(rejected, "Unsafe APK URL accepted: " + url);
        }
        Signature a = new Signature(new byte[]{1, 2, 3});
        Signature b = new Signature(new byte[]{4, 5, 6});
        Signature c = new Signature(new byte[]{7, 8, 9});
        check(NativeBridge.sameSigners(new Signature[]{a, b}, new Signature[]{b, a}),
                "Equivalent multi-signer sets were rejected");
        check(!NativeBridge.sameSigners(new Signature[]{a}, new Signature[]{c})
                && !NativeBridge.sameSigners(null, new Signature[]{a})
                && !NativeBridge.sameSigners(new Signature[]{}, new Signature[]{}),
                "Missing or different signers were accepted");
        // Parse the very APK installed by the simulator, using the same code path
        // as a downloaded archive. Its signature must match; its version must
        // then be rejected as non-increasing. No network or installer is used.
        boolean versionRejected = false;
        try {
            NativeBridge.verifyUpdateApk(getTargetContext(),
                    new File(getTargetContext().getApplicationInfo().sourceDir));
        } catch (Exception expected) {
            versionRejected = expected.getMessage() != null
                    && expected.getMessage().contains("版本没有高于当前版本");
        }
        check(versionRejected, "Installed APK archive did not pass signing and fail the version guard");
        pass();
    }

    private void testOnlineScopedSearch() throws Exception {
        step = "live scoped search rendered in the modern reader";
        await("!!document.querySelector('#search-scope') && !!document.querySelector('#nav-search') && " +
                "!!document.querySelector('#nav-tree') && !!document.querySelector('[data-guide=\"" + ARTICLE + "\"]')", 20000);
        for (String scope : new String[]{"all", "title", "orig", "trans"}) {
            final String label = "all".equals(scope) ? "全部" : "title".equals(scope) ? "篇名" :
                    "orig".equals(scope) ? "原文" : "白话";
            js("(function(){var s=document.querySelector('#search-scope'),i=document.querySelector('#nav-search')," +
                    "f=document.querySelector('#search-form'),e=document.createEvent('Event');" +
                    "s.value=" + JSONObject.quote(scope) + ";i.value='念佛';" +
                    "e.initEvent('submit',true,true);f.dispatchEvent(e);return true;}())");
            await("document.querySelector('.search-count') && " +
                    "document.querySelector('.search-count').textContent.indexOf(" + JSONObject.quote(label) +
                    ") === 0 && document.querySelectorAll('#nav-tree .search-hit').length > 0", 25000);
            check(Boolean.TRUE.equals(js("!document.querySelector('#nav-tree').textContent.includes('索引尚未就绪') && " +
                    "!document.querySelector('#nav-tree').textContent.includes('正文检索暂不可用')")),
                    "Search results include an unavailable-index warning for " + scope);
            steps.add("PASS live search scope " + scope);
        }
        pass();
    }

    private void runModern() throws Exception {
        step = "modern reader startup and article interaction";
        await("!!document.querySelector('[data-guide=\"" + ARTICLE + "\"]')", 30000);
        click("[data-guide='" + ARTICLE + "']");
        await("!!document.querySelector('.art-body .p-orig') && !!document.querySelector('.mode-bar [data-m=\"trans\"]')", 20000);
        JSONObject article = new JSONObject(asset("data/articles/" + ARTICLE + ".json"));
        check(article.getString("title").equals(js("document.querySelector('.art-title').textContent")),
                "Modern reader opened the wrong article");
        check(number(js("document.querySelectorAll('.art-body .p-orig').length")) == paragraphs(article, "orig").size(),
                "Modern original paragraph count differs from the APK asset");
        click(".mode-bar [data-m='trans']");
        await("document.querySelector('.art-body').getAttribute('data-mode') === 'trans'", 5000);
        check(number(js("document.querySelector('.art-body .p-trans').offsetHeight")) > 0,
                "Translation control did not expose visible text");
        pass();

        testBookmarkAndBackup(article);
        testNativeTts();
        if (!updateMode.isEmpty()) testOptionalUpdate();
        testShareFromSelection();
    }

    private void testBookmarkAndBackup(JSONObject article) throws Exception {
        step = "bookmark persists in WebView localStorage and appears under Mine";
        // The suite is intended for a disposable emulator, but keeps all
        // unrelated reading records. Normalize only the one article it owns.
        if (Boolean.TRUE.equals(js("document.querySelector('.mb-bookmark').getAttribute('aria-pressed') === 'true'"))) {
            click(".mb-bookmark");
        }
        click(".mb-bookmark");
        check(Boolean.TRUE.equals(js("document.querySelector('.mb-bookmark').getAttribute('aria-pressed') === 'true'")),
                "Bookmark button did not switch on");
        check(article.getString("title").equals(js("JSON.parse(localStorage.getItem('wc.bookmarks'))['" + ARTICLE + "'].t")),
                "Bookmark was not saved with the bundled article title");
        click("#btn-mine");
        await("location.hash === '#me' && !!document.getElementById('backup-export')", 10000);
        check(article.getString("title").equals(js("document.querySelector('.mine-item[data-go=\"" + ARTICLE + "\"] .mi-title').textContent")),
                "The saved article is absent from the Mine bookmark list");
        pass();

        step = "exported backup contains the real bookmark and reading records";
        click("#backup-export");
        await("document.getElementById('backup-text').value.length > 50", 5000);
        String raw = String.valueOf(js("document.getElementById('backup-text').value"));
        JSONObject backup = new JSONObject(raw);
        check("wenchao-reading-records".equals(backup.getString("format")) && backup.getInt("version") == 1,
                "Export produced an unsupported backup format");
        JSONObject data = backup.getJSONObject("data");
        check(article.getString("title").equals(data.getJSONObject("bookmarks").getJSONObject(ARTICLE).getString("t")),
                "Export lost the real bookmark");
        check(data.has("progress") && data.has("lastRead") && data.has("highlights"),
                "Export omitted a reading-record field");
        pass();

        step = "import backup through the visible text recovery controls";
        click(".mine-item[data-go='" + ARTICLE + "']");
        await("location.pathname.indexOf('/a/" + ARTICLE + "/') === 0 && !!document.querySelector('.mb-bookmark')", 10000);
        click(".mb-bookmark");
        check(Boolean.TRUE.equals(js("!JSON.parse(localStorage.getItem('wc.bookmarks'))['" + ARTICLE + "']")),
                "Test bookmark did not clear before import");
        click("#btn-mine");
        await("location.hash === '#me' && !!document.getElementById('backup-import')", 10000);
        click("#backup-import");
        input("backup-text", raw);
        click("#backup-restore-text");
        await("document.getElementById('backup-status').textContent.indexOf('导入完成') >= 0", 10000);
        check(article.getString("title").equals(js("JSON.parse(localStorage.getItem('wc.bookmarks'))['" + ARTICLE + "'].t")),
                "Import did not restore the bookmark");
        check(number(js("document.querySelectorAll('.mine-item[data-go=\"" + ARTICLE + "\"]').length")) == 1,
                "Import did not refresh the Mine list");
        click(".mine-item[data-go='" + ARTICLE + "']");
        await("location.pathname.indexOf('/a/" + ARTICLE + "/') === 0 && !!document.querySelector('.mb-bookmark')", 10000);
        check(Boolean.TRUE.equals(js("document.querySelector('.mb-bookmark').getAttribute('aria-pressed') === 'true'")),
                "Restored bookmark state is missing when the article is reopened");
        pass();
    }

    private void testNativeTts() throws Exception {
        step = "native speech bridge and local-reader control";
        check("1.1.4".equals(js("window.__wcNative.appVersion()")),
                "The installed APK is not the 1.1.4 build under test");
        check(Boolean.TRUE.equals(js("typeof window.__wcNative.ttsAvailable === 'function' && " +
                "typeof window.__wcNative.ttsSpeak === 'function' && typeof window.__wcNative.ttsStop === 'function'")),
                "The speech bridge is unavailable");

        // The UI's default voice may be a cloud voice. Reload with the local
        // voice selected so this test neither spends AI/TTS credits nor treats
        // a network result as a test of the device speech engine.
        Object previousVoice = js("localStorage.getItem('wc.ttsVoice')");
        js("(function(){localStorage.setItem('wc.ttsVoice','\"local\"');" +
                "window.__compatSmokeReloadMarker=true;return true;}())");
        runOnMainSync(new Runnable() {
            @Override public void run() { web.reload(); }
        });
        await("!window.__compatSmokeReloadMarker && !!document.querySelector('.art-body .p-orig') && " +
                "!!document.querySelector('.mb-speak')", 20000);
        boolean available = Boolean.TRUE.equals(js("window.__wcNative.ttsAvailable()"));
        if (available) {
            js("(function(){window.__compatTtsResult='pending';" +
                    "window.__wcCall('ttsSpeak','测试朗读',1).then(function(r){window.__compatTtsResult=r;});return true;}())");
            boolean returned = true;
            try {
                await("window.__compatTtsResult && window.__compatTtsResult !== 'pending'", 20000);
            } catch (AssertionError slowEngine) {
                if (!String.valueOf(slowEngine.getMessage()).startsWith("Timed out waiting for:")) throw slowEngine;
                returned = false;
            }
            JSONObject speech = returned ? (JSONObject) js("window.__compatTtsResult") : null;
            js("(function(){window.__wcNative.ttsStop();return true;}())");
            click(".mb-speak");
            if (speech != null && speech.optBoolean("ok")) {
                await("document.querySelector('.read-bar') && !document.querySelector('.read-bar').hidden", 5000);
                check(Boolean.TRUE.equals(js("document.querySelector('.mb-speak').classList.contains('on')")),
                        "The reading control did not enter playing state");
                click(".read-bar .rb-x");
                await("document.querySelector('.read-bar').hidden", 5000);
                steps.add("INFO System TTS callback completed; audible sound still requires a speaker check");
            } else {
                await("document.getElementById('wc-toast') && " +
                        "document.getElementById('wc-toast').textContent.indexOf('本机朗读失败') >= 0 && " +
                        "!document.querySelector('.mb-speak').classList.contains('on')", 25000);
                steps.add(returned
                        ? "DIAG System TTS failed despite reporting Chinese support; reader stopped with a visible warning"
                        : "DIAG System TTS never called back; reader watchdog stopped with a visible warning");
            }
        } else {
            click(".mb-speak");
            await("document.getElementById('wc-toast') && " +
                    "document.getElementById('wc-toast').textContent.indexOf('本设备不支持本机朗读') >= 0", 5000);
            steps.add("DIAG No Chinese system TTS engine; reader reported unavailable instead of pretending to play");
        }
        if (previousVoice == JSONObject.NULL) js("(function(){localStorage.removeItem('wc.ttsVoice');return true;}())");
        else js("(function(){localStorage.setItem('wc.ttsVoice'," + JSONObject.quote(String.valueOf(previousVoice)) + ");return true;}())");
        pass();
    }

    private void testOptionalUpdate() throws Exception {
        step = "optional " + updateMode + " read-only update check";
        check("offline".equals(updateMode) || "online".equals(updateMode),
                "Use -e update offline or -e update online");
        click("#btn-mine");
        await("location.hash === '#me' && !!document.getElementById('chk-update')", 10000);
        boolean online = Boolean.TRUE.equals(js("window.__wcNative.isOnline()"));
        if ("offline".equals(updateMode)) {
            check(!online, "Device must be disconnected for the offline-update test");
            click("#chk-update");
            await("document.getElementById('wc-toast') && " +
                    "document.getElementById('wc-toast').textContent.indexOf('当前没有网络') >= 0", 5000);
            check(Boolean.TRUE.equals(js("!document.getElementById('chk-update').disabled")),
                    "Offline check left the button disabled");
        } else {
            check(online, "Device needs a network connection for the online-update test");
            js("(function(){window.__compatUpdateResult='pending';" +
                    "window.__wcCall('checkUpdate').then(function(r){window.__compatUpdateResult=r;});return true;}())");
            await("window.__compatUpdateResult && window.__compatUpdateResult !== 'pending'", 35000);
            JSONObject remote = (JSONObject) js("window.__compatUpdateResult");
            check(remote.optBoolean("ok"), "Read-only update query failed: " + remote.optString("error"));
            check(remote.optInt("count", -1) >= 0 && !remote.optString("current").isEmpty()
                    && !remote.optString("version").isEmpty(),
                    "Update query returned an incomplete manifest comparison");
            steps.add("INFO Remote content version=" + remote.optString("version")
                    + ", app version=" + remote.optString("appVersion")
                    + ", changed items=" + remote.optInt("count"));
        }
        pass();
        click(".mine-item[data-go='" + ARTICLE + "']");
        await("location.pathname.indexOf('/a/" + ARTICLE + "/') === 0 && !!document.querySelector('.art-body .p-orig')", 10000);
    }

    private void testShareFromSelection() throws Exception {
        step = "selected source text creates a real card and native share intent";
        click(".mode-bar [data-m='orig']");
        String selected = String.valueOf(js("(function(){var p=document.querySelector('.art-body .p-orig')," +
                "w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT,null,false),n;" +
                "while((n=w.nextNode()) && !n.nodeValue.trim()){};" +
                "if(!n)return '';var r=document.createRange(),s=window.getSelection();" +
                "r.setStart(n,0);r.setEnd(n,Math.min(n.nodeValue.length,24));" +
                "s.removeAllRanges();s.addRange(r);var ev=document.createEvent('Event');" +
                "ev.initEvent('selectionchange',true,true);document.dispatchEvent(ev);return s.toString();}())"));
        check(!selected.trim().isEmpty(), "Could not select actual source text");
        await("document.querySelector('.share-bar') && !document.querySelector('.share-bar').hidden", 5000);
        check(Boolean.TRUE.equals(js("document.querySelector('.share-bar .sb-make').textContent.indexOf('法布施') >= 0")),
                "The share entry did not appear for the selection");
        click(".share-bar .sb-make");
        await("document.querySelector('.share-modal .sm-img').src.indexOf('data:image/png;base64,') === 0", 25000);
        check(Boolean.TRUE.equals(js("!document.querySelector('.share-modal').hidden && " +
                "!!document.querySelector('.share-modal .sm-share')")),
                "The real card did not expose native sharing");

        if (Build.VERSION.SDK_INT >= 29) {
            step = "share card saves a real PNG to the system gallery";
            click(".share-modal .sm-save");
            await("document.querySelector('.share-modal .sm-save').textContent.indexOf('已存入相册') >= 0", 15000);
            pass();
        } else {
            step = "share card saves a real PNG through the system document picker";
            ActivityMonitor picker = addMonitor(new IntentFilter(Intent.ACTION_CREATE_DOCUMENT), null, false);
            try {
                click(".share-modal .sm-save");
                long end = SystemClock.uptimeMillis() + 15000;
                while (picker.getHits() == 0 && SystemClock.uptimeMillis() < end) SystemClock.sleep(100);
                check(picker.getHits() > 0, "NativeBridge did not open the system document picker");
                tapSystemSaveButton();
                await("document.querySelector('.share-modal .sm-save').textContent.indexOf('已保存到所选位置') >= 0", 15000);
                pass();
            } finally {
                removeMonitor(picker);
            }
        }

        step = "selected source text creates a real card and native share intent";
        IntentFilter chooserFilter = new IntentFilter(Intent.ACTION_CHOOSER);
        ActivityMonitor chooser = addMonitor(chooserFilter, null, false);
        try {
            click(".share-modal .sm-share");
            long end = SystemClock.uptimeMillis() + 15000;
            while (chooser.getHits() == 0 && SystemClock.uptimeMillis() < end) SystemClock.sleep(100);
            check(chooser.getHits() > 0, "NativeBridge did not start the Android image chooser");
            File directory = new File(getTargetContext().getCacheDir(), "share");
            File[] cards = directory.listFiles();
            boolean hasPng = false;
            if (cards != null) for (File card : cards) {
                if (card.getName().endsWith(".png") && card.length() > 1000) hasPng = true;
            }
            check(hasPng, "NativeBridge did not write a non-empty share card to its private cache");
        } finally {
            removeMonitor(chooser);
        }
        pass();
    }

    private void input(String id, String value) throws Exception {
        js("(function(){var e=document.getElementById(" + JSONObject.quote(id) + ");e.value=" +
                JSONObject.quote(value) + ";var ev=document.createEvent('Event');ev.initEvent('input',true,true);e.dispatchEvent(ev);return true;}())");
    }

    private void select(String id, String value) throws Exception {
        js("(function(){var e=document.getElementById(" + JSONObject.quote(id) + ");e.value=" +
                JSONObject.quote(value) + ";var ev=document.createEvent('Event');ev.initEvent('change',true,true);e.dispatchEvent(ev);return true;}())");
    }

    private void click(String selector) throws Exception {
        js("(function(){var e=document.querySelector(" + JSONObject.quote(selector) + ");" +
                "if(!e)throw new Error('Missing control: '+" + JSONObject.quote(selector) + ");" +
                "if(e.disabled)throw new Error('Control disabled');e.click();return true;}())");
    }

    private void tapSystemSaveButton() {
        long end = SystemClock.uptimeMillis() + 10000;
        do {
            AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
            if (root != null) {
                ArrayList<AccessibilityNodeInfo> queue = new ArrayList<>();
                queue.add(root);
                for (int i = 0; i < queue.size(); i++) {
                    AccessibilityNodeInfo node = queue.get(i);
                    CharSequence label = node.getText();
                    String title = label == null ? "" : label.toString().trim();
                    if (("Save".equalsIgnoreCase(title) || "保存".equals(title)) && node.isEnabled()) {
                        AccessibilityNodeInfo target = node;
                        while (target != null && !target.isClickable()) target = target.getParent();
                        if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return;
                    }
                    for (int j = 0; j < node.getChildCount(); j++) {
                        AccessibilityNodeInfo child = node.getChild(j);
                        if (child != null) queue.add(child);
                    }
                }
            }
            SystemClock.sleep(150);
        } while (SystemClock.uptimeMillis() < end);
        throw new AssertionError("The system document picker did not expose an enabled Save button");
    }

    private void compareText(String selector, List<String> expected) throws Exception {
        JSONArray actual = (JSONArray) js("(function(){var a=[],n=document.querySelectorAll(" +
                JSONObject.quote(selector) + ");for(var i=0;i<n.length;i++)a.push(n[i].textContent);return a;}())");
        check(actual.length() == expected.size(), selector + " count mismatch: " + actual.length() + " / " + expected.size());
        for (int i = 0; i < actual.length(); i++) check(expected.get(i).equals(actual.getString(i)),
                selector + " text differs from the bundled article at paragraph " + i);
    }

    private Object js(final String expression) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] answer = new String[1];
        final Throwable[] error = new Throwable[1];
        runOnMainSync(new Runnable() {
            @Override public void run() {
                try {
                    web.evaluateJavascript("(function(){try{return JSON.stringify({ok:true,value:(" +
                            expression + ")});}catch(e){return JSON.stringify({ok:false,error:String(e)});}}())",
                            new ValueCallback<String>() {
                                @Override public void onReceiveValue(String value) { answer[0] = value; latch.countDown(); }
                            });
                } catch (Throwable failure) { error[0] = failure; latch.countDown(); }
            }
        });
        check(latch.await(30, TimeUnit.SECONDS), "WebView evaluateJavascript timed out");
        if (error[0] != null) throw new Exception("WebView evaluation failed", error[0]);
        Object decoded = new JSONTokener(answer[0] == null ? "null" : answer[0]).nextValue();
        check(decoded instanceof String, "WebView returned no JSON result: " + answer[0]);
        JSONObject result = new JSONObject((String) decoded);
        check(result.optBoolean("ok"), "JavaScript failed: " + result.optString("error"));
        return result.opt("value");
    }

    private void await(String condition, long timeoutMs) throws Exception {
        long end = SystemClock.uptimeMillis() + timeoutMs;
        do {
            try {
                if (Boolean.TRUE.equals(js("!!(" + condition + ")"))) return;
            } catch (AssertionError duringNavigation) {
                // A reload can destroy the previous JS context between enqueueing an
                // evaluation and receiving its callback. Retry only that null result;
                // application errors and ordinary failed assertions stay failures.
                if (!String.valueOf(duringNavigation.getMessage()).startsWith(
                        "WebView returned no JSON result")) throw duringNavigation;
            }
            SystemClock.sleep(100);
        } while (SystemClock.uptimeMillis() < end);
        throw new AssertionError("Timed out waiting for: " + condition);
    }

    private String asset(String path) throws Exception {
        InputStream in = getTargetContext().getAssets().open(path);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        } finally { in.close(); }
    }

    private static List<String> catalogIds(JSONArray books) throws Exception {
        List<String> ids = new ArrayList<>();
        for (int v = 0; v < books.length(); v++) {
            JSONArray juans = books.getJSONObject(v).getJSONArray("juans");
            for (int j = 0; j < juans.length(); j++) {
                JSONArray cats = juans.getJSONObject(j).getJSONArray("cats");
                for (int c = 0; c < cats.length(); c++) {
                    JSONArray items = cats.getJSONObject(c).getJSONArray("items");
                    for (int i = 0; i < items.length(); i++) ids.add(items.getJSONObject(i).getString("id"));
                }
            }
        }
        return ids;
    }

    private static List<String> paragraphs(JSONObject article, String layer) throws Exception {
        List<String> text = new ArrayList<>();
        JSONArray segments = article.getJSONArray("segments");
        for (int s = 0; s < segments.length(); s++) {
            JSONArray lines = segments.getJSONObject(s).optJSONArray(layer);
            if (lines != null) for (int i = 0; i < lines.length(); i++) text.add(lines.getString(i));
        }
        return text;
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWebView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private static int number(Object value) { return ((Number) value).intValue(); }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private void pass() {
        steps.add("PASS " + step);
        Bundle status = new Bundle();
        status.putString("stream", "PASS " + step + "\n");
        sendStatus(0, status);
    }
}
