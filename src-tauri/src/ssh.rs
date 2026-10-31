//! SSH side of the connection: interactive terminal, one-shot commands
//! (live stats, routes, WireGuard) and long-running streams (syslog, tcpdump).
//!
//! The REST API cannot stream and has no Linux-level data, so SSH is used
//! for everything "live". Host keys are pinned the same way as TLS certs.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::state::Out;
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};

pub struct HostKeyCheck {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().fingerprint(HashAlg::Sha256).to_string()
            }
        };
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(fp.clone());
        }
        Ok(self.expected.as_deref() == Some(fp.as_str()))
    }
}

pub struct SshClient {
    handle: Handle<HostKeyCheck>,
    host_fingerprint: String,
}

/// What a running terminal or stream task accepts from the UI.
pub enum TermInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum StreamEvent {
    Data(String),
    Closed(Option<u32>),
}

#[derive(Serialize)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

/// A saved SSH secret that is a private key (OpenSSH format) rather than a password.
pub fn is_private_key(secret: &str) -> bool {
    secret
        .trim_start()
        .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
}

/// The public half of a saved private key: ("ssh-ed25519", base64 body).
pub fn public_of(private: &str) -> Option<(String, String)> {
    let key = russh::keys::PrivateKey::from_openssh(private).ok()?;
    let line = key.public_key().to_openssh().ok()?;
    let mut parts = line.split_whitespace();
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

/// A new Ed25519 key for VyGi's login: (private key in OpenSSH format, public key line).
pub fn new_key(comment: &str) -> AppResult<(String, String)> {
    use russh::keys::ssh_key::private::Ed25519Keypair;
    use russh::keys::ssh_key::LineEnding;
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| AppError::Invalid(e.to_string()))?;
    let mut key = russh::keys::PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    key.set_comment(comment);
    let private = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::Invalid(e.to_string()))?
        .to_string();
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    Ok((private, public))
}

impl SshClient {
    pub async fn connect(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        pinned_fp: Option<String>,
    ) -> AppResult<Self> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 3,
            ..Default::default()
        });
        let seen = Arc::new(Mutex::new(None));
        let handler = HostKeyCheck {
            expected: pinned_fp.clone(),
            seen: seen.clone(),
        };

        let connect = client::connect(config, (host, port), handler);
        let result = tokio::time::timeout(Duration::from_secs(10), connect)
            .await
            .map_err(|_| AppError::Timeout(format!("SSH to {host}:{port}")))?;

        let mut handle = match result {
            Ok(h) => h,
            Err(e) => {
                let seen_fp = seen.lock().ok().and_then(|g| g.clone());
                return Err(match (seen_fp, pinned_fp) {
                    (Some(fp), None) => AppError::UntrustedHostKey { fingerprint: fp },
                    (Some(fp), Some(expected)) if fp != expected => AppError::HostKeyMismatch {
                        expected,
                        fingerprint: fp,
                    },
                    _ => AppError::Ssh(e.to_string()),
                });
            }
        };

        // the saved secret is a password, or (VyGi's own login) a private key
        let auth = if is_private_key(password) {
            let key = russh::keys::PrivateKey::from_openssh(password)
                .map_err(|e| AppError::Invalid(format!("the saved SSH key can't be read: {e}")))?;
            handle
                .authenticate_publickey(
                    user,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await?
        } else {
            handle.authenticate_password(user, password).await?
        };
        if !auth.success() {
            return Err(AppError::AuthFailed(if is_private_key(password) {
                "the router didn't accept VyGi's SSH key".into()
            } else {
                "SSH username/password rejected".into()
            }));
        }
        let host_fingerprint = seen.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
        Ok(Self {
            handle,
            host_fingerprint,
        })
    }

    pub fn host_fingerprint(&self) -> &str {
        &self.host_fingerprint
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }

    /// Runs a command and collects its output.
    pub async fn exec(&self, command: &str, timeout: Duration) -> AppResult<ExecOutput> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;

        let collect = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
        };
        tokio::time::timeout(timeout, collect)
            .await
            .map_err(|_| AppError::Timeout(format!("command `{command}`")))?;

        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
        })
    }

    /// Like `exec`, but fails unless the command exited 0, and returns stdout only.
    pub async fn exec_ok(&self, command: &str) -> AppResult<String> {
        let out = self.exec(command, Duration::from_secs(20)).await?;
        match out.exit_code {
            Some(0) | None => Ok(out.stdout),
            Some(code) => Err(AppError::Ssh(format!(
                "`{command}` exited with {code}: {}",
                out.stderr.trim()
            ))),
        }
    }

    /// Opens an interactive login shell with a PTY. Output goes to `on_data`;
    /// the returned sender accepts keystrokes and resizes.
    pub async fn open_shell(
        &self,
        cols: u32,
        rows: u32,
        on_data: Out<StreamEvent>,
    ) -> AppResult<mpsc::Sender<TermInput>> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;
        Ok(spawn_pump(channel, on_data))
    }

    /// Starts a long-running command (e.g. `journalctl -f`) and streams its output.
    pub async fn open_stream(
        &self,
        command: &str,
        on_data: Out<StreamEvent>,
    ) -> AppResult<mpsc::Sender<TermInput>> {
        let channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        Ok(spawn_pump(channel, on_data))
    }

    /// Starts a command and returns its channel, for callers that process the output themselves.
    pub async fn exec_channel(&self, command: &str) -> AppResult<russh::Channel<client::Msg>> {
        let channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        Ok(channel)
    }
}

/// One task owns the SSH channel: it forwards output to the UI and input to the router.
fn spawn_pump(
    mut channel: russh::Channel<client::Msg>,
    on_data: Out<StreamEvent>,
) -> mpsc::Sender<TermInput> {
    let (tx, mut rx) = mpsc::channel::<TermInput>(256);
    tokio::spawn(async move {
        let mut exit = None;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = String::from_utf8_lossy(&data).into_owned();
                        if on_data.send(StreamEvent::Data(text)).is_err() {
                            break; // window was closed on the UI side
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                input = rx.recv() => match input {
                    Some(TermInput::Data(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(TermInput::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(TermInput::Close) | None => {
                        let _ = channel.close().await;
                        break;
                    }
                },
            }
        }
        let _ = on_data.send(StreamEvent::Closed(exit));
    });
    tx
}

/// Quotes a string for safe use as one argument in a POSIX shell command.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Accepts only names that are safe to put in a command without quoting
/// (interface names, VRF names).
pub fn validate_name(s: &str) -> AppResult<&str> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@'));
    if ok {
        Ok(s)
    } else {
        Err(AppError::Invalid(format!("bad name `{s}`")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("port 22"), "'port 22'");
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn names() {
        assert!(validate_name("eth0.10").is_ok());
        assert!(validate_name("wg0").is_ok());
        assert!(validate_name("eth0; rm -rf /").is_err());
        assert!(validate_name("").is_err());
    }
}
