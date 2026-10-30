use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Every error the backend can hand to the UI.
///
/// Serialized as `{ kind, message, fingerprint?, expected? }` so the frontend
/// can react to specific cases (e.g. ask the user to trust a new certificate).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not connected to a router")]
    NotConnected,
    #[error("The router's HTTPS certificate is not trusted yet")]
    UntrustedCert { fingerprint: String },
    #[error("The router's HTTPS certificate CHANGED since last time. This can mean a man-in-the-middle attack, or that the router was reinstalled.")]
    CertMismatch {
        expected: String,
        fingerprint: String,
    },
    #[error("The router's SSH host key is not trusted yet")]
    UntrustedHostKey { fingerprint: String },
    #[error("The router's SSH host key CHANGED since last time. This can mean a man-in-the-middle attack, or that the router was reinstalled.")]
    HostKeyMismatch {
        expected: String,
        fingerprint: String,
    },
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
    #[error("Router API error: {0}")]
    Api(String),
    #[error("Connection error: {0}")]
    Http(String),
    #[error("SSH error: {0}")]
    Ssh(String),
    #[error("OS keychain error: {0}")]
    Keyring(String),
    #[error("File error: {0}")]
    Io(String),
    #[error("Invalid input: {0}")]
    Invalid(String),
    #[error("Timed out: {0}")]
    Timeout(String),
    /// The router answers over SSH, but not its HTTPS API.
    #[error("{0}")]
    ApiDown(String),
    #[error("Another change is waiting for Confirm on this router (from another VyGi window, the CLI or someone else). Keep it with Confirm, or let it revert, before making a new change.")]
    ForeignPending,
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::NotConnected => "NotConnected",
            AppError::UntrustedCert { .. } => "UntrustedCert",
            AppError::CertMismatch { .. } => "CertMismatch",
            AppError::UntrustedHostKey { .. } => "UntrustedHostKey",
            AppError::HostKeyMismatch { .. } => "HostKeyMismatch",
            AppError::AuthFailed(_) => "AuthFailed",
            AppError::Api(_) => "Api",
            AppError::Http(_) => "Http",
            AppError::Ssh(_) => "Ssh",
            AppError::Keyring(_) => "Keyring",
            AppError::Io(_) => "Io",
            AppError::Invalid(_) => "Invalid",
            AppError::Timeout(_) => "Timeout",
            AppError::ApiDown(_) => "ApiDown",
            AppError::ForeignPending => "ForeignPending",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 4)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        let (fingerprint, expected) = match self {
            AppError::UntrustedCert { fingerprint }
            | AppError::UntrustedHostKey { fingerprint } => (Some(fingerprint.as_str()), None),
            AppError::CertMismatch {
                expected,
                fingerprint,
            }
            | AppError::HostKeyMismatch {
                expected,
                fingerprint,
            } => (Some(fingerprint.as_str()), Some(expected.as_str())),
            _ => (None, None),
        };
        s.serialize_field("fingerprint", &fingerprint)?;
        s.serialize_field("expected", &expected)?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Io(format!("JSON: {e}"))
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keyring(e.to_string())
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
