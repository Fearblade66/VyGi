//! Certificate pinning ("trust on first use") for the VyOS HTTPS API.
//!
//! VyOS ships with a self-signed certificate, so normal CA validation fails.
//! Instead of disabling verification, we remember the SHA-256 fingerprint of
//! the router's certificate the first time the user approves it, and refuse
//! to talk to anything presenting a different certificate afterwards.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// Formats a SHA-256 digest as `AB:CD:EF:...` like browsers do.
pub fn sha256_fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[derive(Debug)]
pub struct PinnedVerifier {
    expected: Option<String>,
    /// Fingerprint of the last certificate the server presented.
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = sha256_fingerprint(end_entity.as_ref());
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(fp.clone());
        }
        match &self.expected {
            Some(expected) if expected.eq_ignore_ascii_case(&fp) => {
                Ok(ServerCertVerified::assertion())
            }
            _ => Err(rustls::Error::General(
                "certificate fingerprint not trusted".into(),
            )),
        }
    }

    // Signatures are still checked properly: pinning only replaces the CA chain check.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// A rustls client config that only accepts the pinned certificate.
/// The returned `seen` slot receives whatever fingerprint the server presented.
pub fn pinned_client_config(
    expected: Option<String>,
) -> AppResult<(rustls::ClientConfig, Arc<Mutex<Option<String>>>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let seen = Arc::new(Mutex::new(None));
    let verifier = Arc::new(PinnedVerifier {
        expected,
        seen: seen.clone(),
        provider: provider.clone(),
    });
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Http(format!("TLS setup failed: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok((config, seen))
}

/// HTTPS client for public websites (GeoIP database downloads, site icons),
/// verified against the operating system's trusted certificates.
pub fn public_client(timeout: std::time::Duration) -> AppResult<reqwest::Client> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Http(format!("TLS setup failed: {e}")))?
        .with_platform_verifier()
        .map_err(|e| AppError::Http(format!("TLS setup failed: {e}")))?
        .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("VyGi/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::Http(e.to_string()))
}
