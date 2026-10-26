package com.vygi.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * The saved server, and HTTPS to it. VyGi's certificate is self-signed, so
 * the app trusts exactly the certificate the user accepted at setup (its
 * SHA-256 "pin"); a certificate that the phone trusts anyway (a reverse
 * proxy with a real one) is accepted too.
 */
final class Net {
    private Net() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("vygi", Context.MODE_PRIVATE);
    }

    /** "https://host:port" (no trailing slash), or null before setup. */
    static String server(Context c) {
        return prefs(c).getString("server", null);
    }

    static String pin(Context c) {
        return prefs(c).getString("pin", "");
    }

    /** What the user typed -> "https://host:port". VyGi's default port is 8443. */
    static String normalize(String typed) {
        String s = typed.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.isEmpty()) return null;
        if (s.startsWith("http://")) s = s.substring(7);
        if (s.startsWith("https://")) s = s.substring(8);
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);
        boolean hasPort = s.startsWith("[") ? s.contains("]:") : s.contains(":");
        if (s.isEmpty() || s.contains(" ")) return null;
        return "https://" + s + (hasPort ? "" : ":8443");
    }

    static String fingerprint(Certificate cert) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < d.length; i++) {
                if (i > 0) b.append(':');
                b.append(String.format("%02X", d[i] & 0xff));
            }
            return b.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static X509TrustManager systemTrust() throws Exception {
        TrustManagerFactory f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        f.init((KeyStore) null);
        for (TrustManager t : f.getTrustManagers()) {
            if (t instanceof X509TrustManager) return (X509TrustManager) t;
        }
        throw new IllegalStateException("no system trust manager");
    }

    /** True when the phone itself trusts this certificate chain. */
    static boolean systemTrusts(X509Certificate[] chain) {
        try {
            systemTrust().checkServerTrusted(chain, "ECDHE_RSA");
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** An HTTPS connection that accepts only the pinned certificate (or one the phone trusts). */
    static HttpsURLConnection open(String url, String pin) throws IOException {
        HttpsURLConnection conn = (HttpsURLConnection) new URL(url).openConnection();
        try {
            X509TrustManager system = systemTrust();
            TrustManager pinned = new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException {
                    throw new CertificateException("not a server");
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
                    if (chain.length > 0 && !pin.isEmpty() && pin.equals(fingerprint(chain[0]))) return;
                    system.checkServerTrusted(chain, type);
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            };
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[] {pinned}, null);
            conn.setSSLSocketFactory(ctx.getSocketFactory());
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException(e);
        }
        HostnameVerifier normal = HttpsURLConnection.getDefaultHostnameVerifier();
        // the pinned certificate is the server's identity, whatever names it lists
        conn.setHostnameVerifier((host, session) -> {
            try {
                Certificate[] certs = session.getPeerCertificates();
                if (certs.length > 0 && !pin.isEmpty() && pin.equals(fingerprint(certs[0]))) return true;
            } catch (Exception ignored) {
                // fall through to the normal check
            }
            return normal.verify(host, session);
        });
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(20_000);
        return conn;
    }

    /** The certificate the server presents (no trust check: shown to the user to accept). */
    static X509Certificate[] peek(String server) throws Exception {
        URL u = new URL(server);
        TrustManager all = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String type) {}

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String type) {}

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[] {all}, null);
        try (SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket()) {
            s.connect(new java.net.InetSocketAddress(u.getHost(), u.getPort() > 0 ? u.getPort() : 443), 10_000);
            s.setSoTimeout(10_000);
            s.startHandshake();
            Certificate[] certs = s.getSession().getPeerCertificates();
            X509Certificate[] out = new X509Certificate[certs.length];
            for (int i = 0; i < certs.length; i++) out[i] = (X509Certificate) certs[i];
            return out;
        }
    }

    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    /** GET a small JSON document from the server. */
    static String get(Context c, String path, String bearer) throws IOException {
        HttpsURLConnection conn = open(server(c) + path, pin(c));
        try {
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer " + bearer);
            int code = conn.getResponseCode();
            if (code != 200) throw new HttpError(code);
            try (InputStream in = conn.getInputStream()) {
                return read(in);
            }
        } finally {
            conn.disconnect();
        }
    }

    static final class HttpError extends IOException {
        private static final long serialVersionUID = 1L;
        final int code;

        HttpError(int code) {
            super("HTTP " + code);
            this.code = code;
        }
    }
}
