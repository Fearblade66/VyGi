package com.vygi.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;

import javax.net.ssl.HttpsURLConnection;

/**
 * The newest app comes with the VyGi server (the Docker image includes it):
 * when the server has a newer one than this, offer to install it.
 */
final class Updater {
    private Updater() {}

    static long myVersion(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).getLongVersionCode();
        } catch (Exception e) {
            return 0;
        }
    }

    /** Background: looks at /api/app/info and asks on the UI thread when there's a newer app. */
    static void check(Activity a) {
        new Thread(() -> {
            try {
                JSONObject apk = new JSONObject(Net.get(a, "/api/app/info", null)).optJSONObject("apk");
                if (apk == null) return;
                long code = apk.optLong("versionCode", 0);
                long skipped = Net.prefs(a).getLong("skipVersion", 0);
                if (code <= myVersion(a) || code == skipped) return;
                String name = apk.optString("versionName", String.valueOf(code));
                a.runOnUiThread(() -> new AlertDialog.Builder(a)
                        .setTitle("Update the VyGi app?")
                        .setMessage("Your VyGi server has a newer version of this app (" + name + ").")
                        .setPositiveButton("Update", (d, w) -> install(a))
                        .setNeutralButton("Not this version", (d, w) -> Net.prefs(a).edit().putLong("skipVersion", code).apply())
                        .setNegativeButton("Later", null)
                        .show());
            } catch (Exception ignored) {
                // no server, or an older server without the app: nothing to offer
            }
        }).start();
    }

    static void install(Activity a) {
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(a, "Allow VyGi to install apps, then press Update again", Toast.LENGTH_LONG).show();
            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            return;
        }
        Toast.makeText(a, "Downloading the update…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            PackageInstaller pi = a.getPackageManager().getPackageInstaller();
            try {
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(a.getPackageName());
                int id = pi.createSession(params);
                try (PackageInstaller.Session session = pi.openSession(id)) {
                    HttpsURLConnection conn = Net.open(Net.server(a) + "/vygi.apk", Net.pin(a));
                    try (InputStream in = conn.getInputStream(); OutputStream out = session.openWrite("vygi.apk", 0, -1)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        session.fsync(out);
                    } finally {
                        conn.disconnect();
                    }
                    Intent done = new Intent(a, InstallResult.class);
                    // mutable: the installer adds the result to it
                    PendingIntent result = PendingIntent.getBroadcast(a, id, done, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    session.commit(result.getIntentSender());
                }
            } catch (Exception e) {
                a.runOnUiThread(() -> Toast.makeText(a, "Update failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }
}
