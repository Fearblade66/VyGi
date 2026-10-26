package com.vygi.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Every 15 minutes (Android's shortest interval for background work), asks
 * the VyGi server for alerts newer than the last one seen and shows them as
 * notifications. Uses the app's own read-only API token, which the web UI
 * creates after login (androidapp.js).
 */
public class AlertJob extends JobService {
    private static final int JOB_ID = 1;
    static final String CHANNEL = "alerts";
    static final String CHANNEL_URGENT = "alerts-urgent";

    /** Starts the periodic check (again: harmless when it's already scheduled). */
    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, AlertJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build());
    }

    static void cancel(Context c) {
        c.getSystemService(JobScheduler.class).cancel(JOB_ID);
    }

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel normal = new NotificationChannel(CHANNEL, "Alerts", NotificationManager.IMPORTANCE_DEFAULT);
        normal.setDescription("Router alerts from the VyGi server: new devices, restarts, updates");
        NotificationChannel urgent = new NotificationChannel(CHANNEL_URGENT, "Urgent alerts", NotificationManager.IMPORTANCE_HIGH);
        urgent.setDescription("Internet down, attacks, devices down");
        nm.createNotificationChannel(normal);
        nm.createNotificationChannel(urgent);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            check(this);
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    /** One check; also run when the app opens. */
    static void check(Context c) {
        SharedPreferences p = Net.prefs(c);
        String token = p.getString("token", null);
        if (Net.server(c) == null || token == null) return;
        long since = p.getLong("lastAlert", 0);
        try {
            JSONObject body = new JSONObject(Net.get(c, "/api/app/alerts?since=" + since, token));
            JSONArray list = body.getJSONArray("alerts");
            if (since == 0) {
                // first check after setup: start from now, don't replay old alerts
                p.edit().putLong("lastAlert", body.optLong("now", System.currentTimeMillis())).apply();
                return;
            }
            long newest = since;
            channels(c);
            // the server sends newest first; show oldest first, at most 10
            for (int i = Math.min(list.length(), 10) - 1; i >= 0; i--) {
                JSONObject a = list.getJSONObject(i);
                newest = Math.max(newest, a.getLong("at"));
                show(c, a);
            }
            p.edit().putLong("lastAlert", newest).apply();
        } catch (Net.HttpError e) {
            if (e.code == 401) {
                // token revoked (or the server's data was reset): the web UI makes a new one at the next login
                p.edit().remove("token").remove("tokenId").apply();
                showText(c, CHANNEL, "VyGi notifications stopped", "The app's access was revoked. Open VyGi and log in to turn them back on.", 0);
            }
        } catch (Exception e) {
            // server unreachable (no VPN, away from home): try again next time
        }
    }

    private static void show(Context c, JSONObject a) {
        String level = a.optString("level");
        String channel = "bad".equals(level) ? CHANNEL_URGENT : CHANNEL;
        showText(c, channel, "VyGi: " + a.optString("router"), a.optString("text"), (int) (a.optLong("at") % Integer.MAX_VALUE));
    }

    private static void showText(Context c, String channel, String title, String text, int id) {
        channels(c);
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        try {
            c.getSystemService(NotificationManager.class).notify(id, n);
        } catch (SecurityException e) {
            // notifications not allowed
        }
    }
}
