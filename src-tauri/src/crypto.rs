//! End-to-end encryption for sync/backup targets.
//! Passphrase → Argon2id → 256-bit key (kept in the Keychain). Files are sealed with XChaCha20-Poly1305:
//! `LLE1` ‖ 24-byte random nonce ‖ ciphertext+tag. `sync/crypto.json` stores salt + params + a check value.
use crate::error::{AppError, AppResult};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const MAGIC: &[u8; 4] = b"LLE1";
const CHECK: &[u8] = b"local-lib-encryption-check";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoHeader {
    pub v: u32,
    pub kdf: String,
    pub salt: String,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    /// CHECK encrypted with the derived key; verifies the passphrase.
    pub check: String,
}

pub type Key = [u8; 32];

pub fn derive(passphrase: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> AppResult<Key> {
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| AppError::other(e.to_string()))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::other(e.to_string()))?;
    Ok(key)
}

pub fn seal(key: &Key, plain: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher.encrypt(XNonce::from_slice(&nonce), plain).expect("encryption cannot fail");
    let mut out = Vec::with_capacity(4 + 24 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

pub fn open(key: &Key, data: &[u8]) -> AppResult<Vec<u8>> {
    if data.len() < 28 || &data[..4] != MAGIC {
        return Err(AppError::other("this file isn't encrypted with Local Lib (or encryption was turned on elsewhere)"));
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(&data[4..28]), &data[28..])
        .map_err(|_| AppError::other("wrong encryption passphrase, or the file is damaged"))
}

pub fn is_sealed(data: &[u8]) -> bool { data.len() >= 4 && &data[..4] == MAGIC }

/// New header for a fresh target (m = 64 MiB, t = 3, p = 1).
pub fn new_header(passphrase: &str) -> AppResult<(CryptoHeader, Key)> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let (m, t, p) = (65536, 3, 1);
    let key = derive(passphrase, &salt, m, t, p)?;
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok((CryptoHeader { v: 1, kdf: "argon2id".into(), salt: b64.encode(salt), m_kib: m, t, p, check: b64.encode(seal(&key, CHECK)) }, key))
}

/// Derive the key from an existing header and verify the passphrase.
pub fn unlock(h: &CryptoHeader, passphrase: &str) -> AppResult<Key> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let salt = b64.decode(&h.salt).map_err(|e| AppError::other(e.to_string()))?;
    let key = derive(passphrase, &salt, h.m_kib, h.t, h.p)?;
    let check = b64.decode(&h.check).map_err(|e| AppError::other(e.to_string()))?;
    if open(&key, &check).ok().as_deref() != Some(CHECK) {
        return Err(AppError::other("wrong encryption passphrase"));
    }
    Ok(key)
}

pub fn key_to_hex(k: &Key) -> String { k.iter().map(|b| format!("{b:02x}")).collect() }
pub fn key_from_hex(s: &str) -> Option<Key> {
    if s.len() != 64 { return None; }
    let mut k = [0u8; 32];
    for i in 0..32 { k[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?; }
    Some(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_wrong_passphrase() {
        let (h, key) = new_header("correct horse battery staple").unwrap();
        let sealed = seal(&key, b"library state");
        assert!(is_sealed(&sealed));
        assert_ne!(&sealed[28..], b"library state");
        assert_eq!(open(&key, &sealed).unwrap(), b"library state");
        assert_eq!(unlock(&h, "correct horse battery staple").unwrap(), key);
        assert!(unlock(&h, "wrong").is_err());
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(open(&key, &tampered).is_err(), "authenticated: tampering detected");
        assert_eq!(key_from_hex(&key_to_hex(&key)).unwrap(), key);
    }
}
