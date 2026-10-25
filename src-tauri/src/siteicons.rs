//! Site icons (favicons) for the Clients/DNS views, fetched from the sites
//! themselves (no third-party icon service) and cached on disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use tauri::{AppHandle, Manager};
use tokio::task::JoinSet;

use crate::error::{AppError, AppResult};
use crate::tls::public_client;

const MAX_ICON: usize = 100 * 1024;
const MAX_PAGE: usize = 512 * 1024;
const MAX_DOMAINS: usize = 60;
/// Retry sites without an icon after a week.
const MISS_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

/// Local names are never fetched (they would be requests into the LAN).
const LOCAL_SUFFIXES: [&str; 8] = [
    ".lan",
    ".local",
    ".localdomain",
    ".home",
    ".internal",
    ".arpa",
    ".intranet",
    ".corp",
];

/// A public DNS name with at least one dot (no IPs, ports, paths or local names).
pub fn valid_domain(d: &str) -> bool {
    !LOCAL_SUFFIXES.iter().any(|s| d.ends_with(s))
        && d.len() <= 253
        && d.contains('.')
        && !d.starts_with('.')
        && !d.ends_with('.')
        && d.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                && !l.starts_with('-')
        })
        && !d.split('.').all(|l| l.chars().all(|c| c.is_ascii_digit()))
}

/// Image type from the first bytes; anything else is rejected.
fn sniff(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if data.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if data.starts_with(b"GIF8") {
        Some("image/gif")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        let head = String::from_utf8_lossy(&data[..data.len().min(256)]).to_ascii_lowercase();
        (head.trim_start().starts_with("<svg") || head.contains("<svg")).then_some("image/svg+xml")
    }
}

/// Finds `<link rel="icon" href="...">` (or shortcut icon / apple-touch-icon) in HTML.
pub fn icon_href(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut best: Option<(u8, String)> = None;
    let mut pos = 0;
    while let Some(i) = lower[pos..].find("<link") {
        let start = pos + i;
        let end = lower[start..]
            .find('>')
            .map(|e| start + e)
            .unwrap_or(lower.len());
        let tag = &html[start..end];
        let tag_l = &lower[start..end];
        pos = end;
        let Some(rel) = attr(tag, tag_l, "rel") else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let rank = if rel.split_whitespace().any(|r| r == "icon") {
            2
        } else if rel.contains("apple-touch-icon") {
            1
        } else {
            continue;
        };
        if let Some(href) = attr(tag, tag_l, "href") {
            if best.as_ref().map_or(true, |(r, _)| rank > *r) {
                best = Some((rank, href));
            }
        }
    }
    best.map(|(_, h)| h)
}

fn attr(tag: &str, tag_l: &str, name: &str) -> Option<String> {
    let key = format!(" {name}=");
    let i = tag_l.find(&key)? + key.len();
    let rest = &tag[i..];
    let (quote, body) = match rest.chars().next()? {
        q @ ('"' | '\'') => (Some(q), &rest[1..]),
        _ => (None, rest),
    };
    let end = match quote {
        Some(q) => body.find(q)?,
        None => body.find(char::is_whitespace).unwrap_or(body.len()),
    };
    Some(body[..end].trim().replace("&amp;", "&"))
}

/// GET with a size cap. Sets `reached` when the server answered at all.
async fn get_limited(
    client: &reqwest::Client,
    url: &str,
    max: usize,
    reached: &mut bool,
) -> Option<Vec<u8>> {
    let resp = client.get(url).send().await.ok()?;
    *reached = true;
    let mut resp = resp.error_for_status().ok()?;
    // Only follow to https.
    if resp.url().scheme() != "https" || resp.content_length().is_some_and(|l| l as usize > max) {
        return None;
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.ok()? {
        out.extend_from_slice(&chunk);
        if out.len() > max {
            return None;
        }
    }
    Some(out)
}

/// Returns the icon, and whether the site answered at all (so a miss can be cached).
async fn fetch_icon(client: reqwest::Client, domain: String) -> (Option<(String, Vec<u8>)>, bool) {
    let mut reached = false;
    let mut hosts = vec![domain.clone()];
    if !domain.starts_with("www.") {
        hosts.push(format!("www.{domain}"));
    }
    for host in &hosts {
        let base = format!("https://{host}/");
        if let Some(page) = get_limited(&client, &base, MAX_PAGE, &mut reached).await {
            if let Some(href) = icon_href(&String::from_utf8_lossy(&page)) {
                if let Ok(url) = reqwest::Url::parse(&base).and_then(|b| b.join(&href)) {
                    if url.scheme() == "https" {
                        if let Some(data) =
                            get_limited(&client, url.as_str(), MAX_ICON, &mut reached).await
                        {
                            if let Some(mime) = sniff(&data) {
                                return (Some((mime.to_string(), data)), true);
                            }
                        }
                    }
                }
            }
        }
        if let Some(data) = get_limited(
            &client,
            &format!("{base}favicon.ico"),
            MAX_ICON,
            &mut reached,
        )
        .await
        {
            if let Some(mime) = sniff(&data) {
                return (Some((mime.to_string(), data)), true);
            }
        }
    }
    (None, reached)
}

fn cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Invalid(format!("no cache dir: {e}")))?
        .join("site-icons"))
}

fn data_url(mime: &str, data: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    )
}

/// Cached icon: Some(Some(url)) hit, Some(None) known miss, None not cached.
fn cached(dir: &Path, domain: &str) -> Option<Option<String>> {
    if let Ok(data) = std::fs::read(dir.join(format!("{domain}.img"))) {
        return sniff(&data).map(|m| Some(data_url(m, &data)));
    }
    let miss = dir.join(format!("{domain}.none"));
    let fresh = std::fs::metadata(&miss)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < MISS_TTL);
    fresh.then_some(None)
}

/// Icons as data: URLs (null where a site has none). Unknown ones are fetched
/// from the sites, a few at a time.
#[tauri::command]
pub async fn site_icons(
    app: AppHandle,
    domains: Vec<String>,
) -> AppResult<HashMap<String, Option<String>>> {
    let dir = cache_dir(&app)?;
    std::fs::create_dir_all(&dir)?;
    let mut out = HashMap::new();
    let mut todo = Vec::new();
    for d in domains.into_iter().take(MAX_DOMAINS) {
        let d = d.trim().trim_end_matches('.').to_ascii_lowercase();
        if !valid_domain(&d) || out.contains_key(&d) {
            continue;
        }
        match cached(&dir, &d) {
            Some(hit) => {
                out.insert(d, hit);
            }
            None => todo.push(d),
        }
    }
    if todo.is_empty() {
        return Ok(out);
    }
    let client = public_client(Duration::from_secs(8))?;
    let mut set = JoinSet::new();
    let mut queue = todo.into_iter();
    let spawn = |set: &mut JoinSet<_>, d: String| {
        let c = client.clone();
        set.spawn(async move { (d.clone(), fetch_icon(c, d).await) });
    };
    for d in queue.by_ref().take(6) {
        spawn(&mut set, d);
    }
    while let Some(res) = set.join_next().await {
        if let Ok((d, icon)) = res {
            match icon {
                (Some((mime, data)), _) => {
                    let _ = std::fs::write(dir.join(format!("{d}.img")), &data);
                    out.insert(d, Some(data_url(&mime, &data)));
                }
                (None, reached) => {
                    // Remember "no icon" only if the site answered; offline isn't a verdict.
                    if reached {
                        let _ = std::fs::write(dir.join(format!("{d}.none")), b"");
                    }
                    out.insert(d, None);
                }
            }
        }
        if let Some(d) = queue.next() {
            spawn(&mut set, d);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains() {
        assert!(valid_domain("youtube.com"));
        assert!(valid_domain("a-b.example.co.uk"));
        assert!(!valid_domain("localhost"));
        assert!(!valid_domain("1.2.3.4"));
        assert!(!valid_domain("../etc/passwd"));
        assert!(!valid_domain("a..b"));
        assert!(!valid_domain("-a.com"));
        assert!(!valid_domain("a.com/x"));
        assert!(!valid_domain("nas.lan"));
        assert!(!valid_domain("printer.local"));
        assert!(!valid_domain("4.3.2.1.in-addr.arpa"));
    }

    #[test]
    fn finds_icon_links() {
        let html = r#"<head><link rel="stylesheet" href="/a.css"><LINK REL="apple-touch-icon" HREF="/touch.png"><link href='/fav.png' rel='shortcut icon'></head>"#;
        assert_eq!(icon_href(html).as_deref(), Some("/fav.png"));
        assert_eq!(
            icon_href(r#"<link rel=icon href=/i.ico>"#).as_deref(),
            Some("/i.ico")
        );
        assert_eq!(
            icon_href("<link rel=\"apple-touch-icon\" href=\"t.png\">").as_deref(),
            Some("t.png")
        );
        assert_eq!(icon_href("<p>no icons</p>"), None);
    }

    #[test]
    fn sniffs_images() {
        assert_eq!(sniff(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(sniff(&[0, 0, 1, 0, 1]), Some("image/x-icon"));
        assert_eq!(
            sniff(b"<?xml version='1.0'?><svg xmlns=..."),
            Some("image/svg+xml")
        );
        assert_eq!(sniff(b"<html>not an image</html>"), None);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// VYGI_ICON_TEST=<domain>: fetches that site's icon over the network.
    #[tokio::test]
    async fn live_fetch() {
        let Ok(domain) = std::env::var("VYGI_ICON_TEST") else {
            return;
        };
        let client = public_client(Duration::from_secs(8)).expect("client");
        match client.get(format!("https://{domain}/")).send().await {
            Ok(r) => eprintln!("GET / -> {}", r.status()),
            Err(e) => eprintln!("GET / failed: {e:?}"),
        }
        let (icon, reached) = fetch_icon(client, domain).await;
        eprintln!(
            "reached={reached} icon={:?}",
            icon.map(|(m, d)| (m, d.len()))
        );
    }
}
