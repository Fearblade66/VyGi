package com.vygi.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;

/**
 * The VyGi web UI from the user's VyGi server in a WebView, after a one-time
 * setup (server address + accepting its certificate). Everything else
 * (pages, login, phone layout) is the web UI itself.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;

    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.panel));
        if (Build.VERSION.SDK_INT >= 30) {
            // draw under the status and navigation bars on every version (Android 15
            // forces it), then keep the content clear of them and of the keyboard
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(root);
        AlertJob.channels(this);
        if (Net.server(this) == null) showSetup(null);
        else showWeb();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (Net.server(this) != null) new Thread(() -> AlertJob.check(this)).start();
    }

    // ------------------------------------------------------------ setup

    private TextView text(String s, float sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(getColor(color));
        t.setLineSpacing(0, 1.2f);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** First start (or "Change server"): ask for the server's address. */
    private void showSetup(String error) {
        destroyWeb();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(48), dp(24), dp(24));
        TextView title = text("VyGi", 30, R.color.text);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        box.addView(title);
        TextView intro = text("Connects to your VyGi server (the Docker version), at home or over your VPN.", 15, R.color.muted);
        intro.setPadding(0, dp(8), 0, dp(24));
        box.addView(intro);
        box.addView(text("VyGi server address", 13, R.color.muted));
        EditText addr = new EditText(this);
        addr.setHint("192.168.88.31:8443");
        addr.setSingleLine();
        addr.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addr.setImeOptions(EditorInfo.IME_ACTION_GO);
        String last = Net.prefs(this).getString("lastServer", "");
        addr.setText(last.replace("https://", ""));
        box.addView(addr);
        TextView status = text(error == null ? "The same address you open VyGi at in a browser (port 8443 unless you changed it)." : error, 13, error == null ? R.color.muted : R.color.text);
        if (error != null) status.setTextColor(Color.rgb(0xE2, 0x45, 0x3C));
        status.setPadding(0, dp(6), 0, dp(16));
        box.addView(status);
        Button go = new Button(this);
        go.setText("Connect");
        box.addView(go, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        ProgressBar spin = new ProgressBar(this);
        spin.setVisibility(View.GONE);
        box.addView(spin);
        Runnable connect = () -> {
            String server = Net.normalize(addr.getText().toString());
            if (server == null) {
                status.setText("Type the address, e.g. 192.168.88.31:8443");
                return;
            }
            go.setEnabled(false);
            spin.setVisibility(View.VISIBLE);
            status.setText("Connecting to " + server + "…");
            new Thread(() -> probe(server, (err) -> runOnUiThread(() -> {
                go.setEnabled(true);
                spin.setVisibility(View.GONE);
                if (err != null) {
                    status.setTextColor(Color.rgb(0xE2, 0x45, 0x3C));
                    status.setText(err);
                }
            }))).start();
        };
        go.setOnClickListener(v -> connect.run());
        addr.setOnEditorActionListener((v, id, ev) -> {
            connect.run();
            return true;
        });
        root.removeAllViews();
        root.addView(box);
    }

    private interface Done {
        void run(String error);
    }

    /** Reads the server's certificate, checks it's VyGi, and asks the user to trust it. */
    private void probe(String server, Done done) {
        X509Certificate[] chain;
        try {
            chain = Net.peek(server);
        } catch (Exception e) {
            done.run("Couldn't reach " + server + ". Check the address, that you're on your home network or VPN, and that VyGi is running. (" + e.getMessage() + ")");
            return;
        }
        String fp = Net.fingerprint(chain[0]);
        try {
            // is it VyGi? (/api/app/info exists on VyGi servers only)
            JSONObject info = new JSONObject(Net.read(Net.open(server + "/api/app/info", fp).getInputStream()));
            String serverFp = info.optString("fingerprint", "");
            done.run(null);
            boolean trusted = Net.systemTrusts(chain);
            runOnUiThread(() -> {
                if (trusted) {
                    save(server, fp);
                    return;
                }
                new AlertDialog.Builder(this)
                        .setTitle("Trust this VyGi server?")
                        .setMessage("VyGi uses its own certificate. Check that this fingerprint matches the one under Phone app in VyGi on your computer:\n\n" + fp
                                + (serverFp.isEmpty() || serverFp.equals(fp) ? "" : "\n\nWarning: the server reports a different certificate. Something between you and the server may be listening in."))
                        .setPositiveButton("Trust", (d, w) -> save(server, fp))
                        .setNegativeButton("Cancel", null)
                        .show();
            });
        } catch (Exception e) {
            done.run("That address answers, but it doesn't look like a VyGi server (" + e.getMessage() + ").");
        }
    }

    private void save(String server, String fp) {
        String old = Net.server(this);
        Net.prefs(this).edit()
                .putString("server", server)
                .putString("lastServer", server)
                .putString("pin", fp)
                .apply();
        if (old == null || !old.equals(server)) Net.prefs(this).edit().remove("token").remove("tokenId").remove("lastAlert").apply();
        showWeb();
    }

    // ------------------------------------------------------------ the web UI

    @SuppressLint("SetJavaScriptEnabled")
    private void showWeb() {
        destroyWeb();
        String server = Net.server(this);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " VyGiApp/" + Updater.myVersion(this));
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "VyGiApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                X509Certificate cert = error.getCertificate().getX509Certificate();
                String fp = cert == null ? "" : Net.fingerprint(cert);
                if (sameServer(error.getUrl()) && fp.equals(Net.pin(MainActivity.this))) {
                    handler.proceed();
                    return;
                }
                handler.cancel();
                if (sameServer(error.getUrl())) certChanged(fp);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (sameServer(req.getUrl().toString())) return false;
                // links elsewhere (help pages, ntfy, …) open in the browser
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                } catch (Exception ignored) {
                    // no browser
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) offline(String.valueOf(err.getDescription()));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a file"), PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        root.removeAllViews();
        root.addView(web);
        web.loadUrl(server + "/");
        AlertJob.schedule(this);
        askNotifications();
        Updater.check(this);
    }

    private void destroyWeb() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
    }

    private boolean sameServer(String url) {
        try {
            Uri a = Uri.parse(url);
            Uri b = Uri.parse(Net.server(this));
            return "https".equals(a.getScheme()) && b.getHost().equalsIgnoreCase(a.getHost()) && port(a) == port(b);
        } catch (Exception e) {
            return false;
        }
    }

    private static int port(Uri u) {
        return u.getPort() > 0 ? u.getPort() : 443;
    }

    /** The server can't be reached: say so, with Retry and Change server. */
    private void offline(String why) {
        destroyWeb();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(32), dp(32), dp(32), dp(32));
        TextView t = text("Can't reach VyGi", 22, R.color.text);
        t.setGravity(Gravity.CENTER);
        box.addView(t);
        TextView d = text("The VyGi server at " + Net.server(this) + " didn't answer (" + why + "). Away from home? Turn your VPN on.", 15, R.color.muted);
        d.setGravity(Gravity.CENTER);
        d.setPadding(0, dp(10), 0, dp(24));
        box.addView(d);
        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(v -> showWeb());
        box.addView(retry);
        Button change = new Button(this);
        change.setText("Change server");
        change.setOnClickListener(v -> showSetup(null));
        box.addView(change);
        root.removeAllViews();
        root.addView(box);
    }

    /** The server shows a different certificate than the one the user trusted. */
    private void certChanged(String fp) {
        runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle("The server's certificate changed")
                .setMessage("This can be normal (VyGi made a new certificate after its address list changed, or its data was reset), "
                        + "or something is listening in. Trust the new one only if it matches the fingerprint under Phone app in VyGi on your computer:\n\n" + fp)
                .setPositiveButton("Trust the new one", (dlg, w) -> {
                    Net.prefs(this).edit().putString("pin", fp).apply();
                    showWeb();
                })
                .setNegativeButton("Change server", (dlg, w) -> showSetup(null))
                .setCancelable(false)
                .show());
    }

    private void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !Net.prefs(this).getBoolean("askedNotify", false)) {
            Net.prefs(this).edit().putBoolean("askedNotify", true).apply();
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 2);
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILE && fileCallback != null) {
            Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
            fileCallback.onReceiveValue(uri == null ? null : new Uri[] {uri});
            fileCallback = null;
        }
    }

    /** Back closes the innermost thing in the web UI (dialog, menu, window), then leaves. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // here rather than onKeyDown: the WebView must not see Back first
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && web != null) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                web.evaluateJavascript("(window.vygiBack && window.vygiBack()) === true", (v) -> {
                    if (!"true".equals(v)) moveTaskToBack(true);
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onDestroy() {
        destroyWeb();
        super.onDestroy();
    }

    // ------------------------------------------------------------ for the web UI (androidapp.js)

    private class Bridge {
        @JavascriptInterface
        public boolean hasToken() {
            return Net.prefs(MainActivity.this).getString("token", null) != null;
        }

        @JavascriptInterface
        public void setToken(String secret, String id) {
            Net.prefs(MainActivity.this).edit().putString("token", secret).putString("tokenId", id).remove("lastAlert").apply();
            new Thread(() -> AlertJob.check(MainActivity.this)).start();
        }

        @JavascriptInterface
        public String deviceName() {
            return Build.MANUFACTURER + " " + Build.MODEL;
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Change server?")
                    .setMessage("The app forgets this server and its certificate. You'll log in again.")
                    .setPositiveButton("Change", (d, w) -> {
                        CookieManager.getInstance().removeAllCookies(null);
                        Net.prefs(MainActivity.this).edit().remove("server").remove("pin").remove("token").remove("tokenId").remove("lastAlert").apply();
                        AlertJob.cancel(MainActivity.this);
                        showSetup(null);
                    })
                    .setNegativeButton("Cancel", null)
                    .show());
        }

        /** Saves a text file (backups, WireGuard configs) to Downloads. */
        @JavascriptInterface
        public boolean saveText(String name, String text) {
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
            v.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
            try {
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return false;
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
