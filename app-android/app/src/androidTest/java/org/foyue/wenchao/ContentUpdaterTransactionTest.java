package org.foyue.wenchao;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Exercises real HTTP downloads and the on-disk update transaction on an
 * isolated app-private root. No production server or installed reading data is
 * touched. CompatibilitySmokeTest calls {@link #run(Context)} on API 19+.
 */
final class ContentUpdaterTransactionTest {
    private static final String A1 = "data/articles/jx-051.json";
    private static final String A2 = "data/articles/jx-052.json";
    private static final String BOOKS = "data/books.json";
    private static final String JS = "js/updater-transaction-smoke.js";
    private static final String CSS = "css/updater-transaction-smoke.css";
    private static final String[] PATHS = {BOOKS, A1, A2, JS, CSS};

    private ContentUpdaterTransactionTest() { }

    static void run(Context context) throws Exception {
        File root = new File(context.getFilesDir(), "update-transaction-test-" + System.nanoTime());
        if (!root.mkdirs()) throw new AssertionError("Could not create isolated update root");
        try (LoopbackServer server = new LoopbackServer()) {
            ContentUpdater updater = new ContentUpdater(context, server.baseUrl(), root);
            Map<String, byte[]> oldFiles = files(context, "old");
            JSONObject oldManifest = manifest("transaction-old", oldFiles);
            server.serve(oldManifest, oldFiles);
            JSONObject fetchedOld = updater.remoteManifest();
            check("transaction-old".equals(fetchedOld.getString("version")), "Loopback manifest was not fetched");
            updater.apply(fetchedOld, null);
            assertActive(updater, root, oldManifest, oldFiles);

            Map<String, byte[]> nextFiles = files(context, "new");
            JSONObject nextManifest = manifest("transaction-new", nextFiles);

            // A valid manifest must never publish bytes with the wrong digest.
            Map<String, byte[]> wrongHash = new LinkedHashMap<>(nextFiles);
            wrongHash.put(A1, Arrays.copyOf(oldFiles.get(A1), oldFiles.get(A1).length));
            server.serve(nextManifest, wrongHash);
            expectFailure(updater, updater.remoteManifest(), "wrong article hash");
            assertActive(updater, root, oldManifest, oldFiles);

            // A later HTTP failure must not expose earlier successful downloads.
            server.serve(nextManifest, nextFiles);
            server.fail(CSS, 503);
            expectFailure(updater, updater.remoteManifest(), "interrupted asset download");
            check(server.successfulResourceRequests() > 0,
                    "Failure test did not first download any staged resource");
            assertActive(updater, root, oldManifest, oldFiles);

            // Retry the exact same manifest with every correct response.
            server.serve(nextManifest, nextFiles);
            updater.apply(updater.remoteManifest(), null);
            assertActive(updater, root, nextManifest, nextFiles);

            // A stale public manifest must not revert newer bundled or applied
            // JavaScript, even when the file hashes differ.
            check(ContentUpdater.remoteOlder(updater.localManifest(), oldManifest),
                    "Older manifest timestamp was not recognized");
            server.serve(oldManifest, oldFiles);
            expectFailure(updater, updater.remoteManifest(), "older content manifest");
            assertActive(updater, root, nextManifest, nextFiles);
        } finally {
            deleteTree(root);
        }
    }

    private static Map<String, byte[]> files(Context context, String label) throws Exception {
        Map<String, byte[]> out = new LinkedHashMap<>();
        // Preserve the production article schema so validation exercises real data.
        JSONObject first = new JSONObject(new String(asset(context, A1), StandardCharsets.UTF_8));
        JSONObject second = new JSONObject(new String(asset(context, A2), StandardCharsets.UTF_8));
        first.put("title", first.getString("title") + " " + label);
        second.put("title", second.getString("title") + " " + label);
        out.put(BOOKS, (new String(asset(context, BOOKS), StandardCharsets.UTF_8)
                + ("old".equals(label) ? "\n" : "\n\n")).getBytes(StandardCharsets.UTF_8));
        out.put(A1, first.toString().getBytes(StandardCharsets.UTF_8));
        out.put(A2, second.toString().getBytes(StandardCharsets.UTF_8));
        out.put(JS, ("window.__updaterTransactionSmoke='" + label + "';\n")
                .getBytes(StandardCharsets.UTF_8));
        out.put(CSS, ("body{--updater-transaction-smoke:" + label + ";}\n")
                .getBytes(StandardCharsets.UTF_8));
        return out;
    }

    private static JSONObject manifest(String version, Map<String, byte[]> files) throws Exception {
        JSONObject articles = new JSONObject();
        articles.put("jx-051", sha(files.get(A1)));
        articles.put("jx-052", sha(files.get(A2)));
        JSONObject assets = new JSONObject();
        assets.put(JS, sha(files.get(JS)));
        assets.put(CSS, sha(files.get(CSS)));
        JSONObject result = new JSONObject();
        result.put("version", version);
        result.put("generated", "transaction-old".equals(version)
                ? "2099-01-01T12:00:00Z" : "2099-01-01T12:01:00Z");
        result.put("books", sha(files.get(BOOKS)));
        result.put("articles", articles);
        result.put("assets", assets);
        return result;
    }

    private static void assertActive(ContentUpdater updater, File root, JSONObject expected,
                                     Map<String, byte[]> expectedFiles) throws Exception {
        JSONObject actual = updater.localManifest();
        check(expected.getString("version").equals(actual.optString("version")),
                "Active manifest version changed unexpectedly");
        check(expected.getString("books").equals(actual.optString("books")),
                "Active directory digest changed unexpectedly");
        for (String path : PATHS) {
            String expectedHash = sha(expectedFiles.get(path));
            String manifestHash = path.equals(BOOKS) ? actual.optString("books")
                    : path.startsWith("data/articles/")
                    ? actual.getJSONObject("articles").optString(path.substring(14, path.length() - 5))
                    : actual.getJSONObject("assets").optString(path);
            check(expectedHash.equals(manifestHash), "Active manifest disagrees with " + path);
            File active = new File(ContentUpdater.activeOverlayDir(root), path);
            check(active.isFile(), "Active overlay is missing " + path);
            check(Arrays.equals(expectedFiles.get(path), read(new FileInputStream(active))),
                    "Active overlay changed unexpectedly: " + path);
        }
    }

    private static void expectFailure(ContentUpdater updater, JSONObject remote, String label)
            throws Exception {
        try {
            updater.apply(remote, null);
        } catch (Exception expected) {
            return;
        }
        throw new AssertionError(label + " was accepted");
    }

    private static String sha(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-1").digest(data);
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) hex.append(String.format("%02x", b & 0xff));
        return hex.substring(0, 12);
    }

    private static byte[] asset(Context context, String path) throws Exception {
        return read(context.getAssets().open(path));
    }

    private static byte[] read(InputStream in) throws Exception {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }

    private static void deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        file.delete();
    }

    private static final class LoopbackServer implements AutoCloseable {
        private final ServerSocket listener;
        private final Thread thread;
        private final ConcurrentHashMap<String, Reply> responses = new ConcurrentHashMap<>();
        private volatile boolean running = true;
        private volatile int successfulResourceRequests;

        LoopbackServer() throws Exception {
            listener = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            thread = new Thread(new Runnable() {
                @Override public void run() { serveLoop(); }
            }, "wenchao-update-test-http");
            thread.setDaemon(true);
            thread.start();
        }

        String baseUrl() { return "http://127.0.0.1:" + listener.getLocalPort(); }
        int successfulResourceRequests() { return successfulResourceRequests; }

        void serve(JSONObject manifest, Map<String, byte[]> files) {
            responses.clear();
            responses.put("/app/content-manifest.json",
                    new Reply(200, manifest.toString().getBytes(StandardCharsets.UTF_8)));
            for (Map.Entry<String, byte[]> entry : files.entrySet()) {
                responses.put("/" + entry.getKey(), new Reply(200, entry.getValue()));
            }
            successfulResourceRequests = 0;
        }

        void fail(String path, int status) {
            responses.put("/" + path, new Reply(status, "test failure".getBytes(StandardCharsets.UTF_8)));
        }

        private void serveLoop() {
            while (running) {
                try (Socket socket = listener.accept()) {
                    socket.setSoTimeout(15000);
                    InputStream in = socket.getInputStream();
                    ByteArrayOutputStream line = new ByteArrayOutputStream();
                    int ch;
                    while ((ch = in.read()) != -1 && ch != '\n') {
                        if (ch != '\r') line.write(ch);
                    }
                    String request = new String(line.toByteArray(), StandardCharsets.US_ASCII);
                    String[] parts = request.split(" ");
                    String path = parts.length > 1 ? parts[1].split("\\?")[0] : "";
                    // Consume headers; the test sends GET with no request body.
                    int previous = -1, now;
                    while ((now = in.read()) != -1) {
                        if (previous == '\n' && now == '\n') break;
                        previous = now == '\r' ? previous : now;
                    }
                    Reply reply = responses.get(path);
                    if (reply == null) reply = new Reply(404, new byte[0]);
                    if (reply.status == 200 && !path.equals("/app/content-manifest.json")) {
                        successfulResourceRequests++;
                    }
                    OutputStream out = socket.getOutputStream();
                    String header = "HTTP/1.1 " + reply.status + " "
                            + (reply.status == 200 ? "OK" : "Test Failure") + "\r\n"
                            + "Content-Length: " + reply.bytes.length + "\r\n"
                            + "Content-Type: application/octet-stream\r\n"
                            + "Connection: close\r\n\r\n";
                    out.write(header.getBytes(StandardCharsets.US_ASCII));
                    out.write(reply.bytes);
                    out.flush();
                } catch (Exception ignored) {
                    if (!running) return;
                }
            }
        }

        @Override public void close() throws Exception {
            running = false;
            listener.close();
            thread.join(1000);
        }
    }

    private static final class Reply {
        final int status;
        final byte[] bytes;
        Reply(int status, byte[] bytes) { this.status = status; this.bytes = bytes; }
    }
}
