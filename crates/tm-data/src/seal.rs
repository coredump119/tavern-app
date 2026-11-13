//! Password-sealed backup files (DEV_NOTES §9.38): argon2id key, AES-256-GCM over 64 KiB chunks.
//!
//! ```text
//! header   "TMSEAL\x01\n" | m_kib u32 LE | t u32 LE | p u32 LE | salt[16] | nonce prefix[7]
//! records  len u32 LE | ciphertext[len]      (ciphertext = chunk + 16-byte tag)
//! nonce    prefix[7] | chunk index u32 BE | last chunk? u8
//! ```
//! The header is the associated data of every chunk, and the last-chunk flag sits in the nonce:
//! a truncated file, swapped chunks or an edited header all fail to open.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use std::io::{Read, Write};
use std::path::Path;
use zeroize::Zeroize;

const MAGIC: &[u8; 8] = b"TMSEAL\x01\n";
const SALT_LEN: usize = 16;
const PREFIX_LEN: usize = 7;
const HEADER_LEN: usize = MAGIC.len() + 12 + SALT_LEN + PREFIX_LEN;
const CHUNK: usize = 64 * 1024;
const TAG_LEN: usize = 16;

/// argon2id cost written into new files (OWASP baseline: 19 MiB, 2 passes)
pub const DEFAULT_COST: Cost = Cost {
    m_kib: 19 * 1024,
    t: 2,
    p: 1,
};
/// upper bounds accepted from a file header, so a forged header cannot exhaust memory
const MAX_COST: Cost = Cost {
    m_kib: 1024 * 1024,
    t: 16,
    p: 8,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cost {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a sealed backup")]
    NotSealed,
    #[error("wrong password")]
    WrongPassword,
    #[error("sealed backup is damaged")]
    Corrupt,
    #[error("key derivation failed")]
    Kdf,
}

/// Does the file start with the sealed-backup magic?
pub fn is_sealed(path: &Path) -> bool {
    let mut head = [0u8; MAGIC.len()];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok_and(|()| &head == MAGIC)
}

fn derive(password: &str, salt: &[u8], cost: Cost) -> Result<[u8; 32], SealError> {
    let params = Params::new(cost.m_kib, cost.t, cost.p, Some(32)).map_err(|_| SealError::Kdf)?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| SealError::Kdf)?;
    Ok(key)
}

fn nonce(prefix: &[u8], index: u32, last: bool) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..PREFIX_LEN].copy_from_slice(prefix);
    n[PREFIX_LEN..PREFIX_LEN + 4].copy_from_slice(&index.to_be_bytes());
    n[11] = u8::from(last);
    n
}

/// Fill `buf` as far as the reader allows; returns how many bytes were read (short only at EOF).
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// Encrypt `src` into `dst` under `password`. `dst` is removed again if anything fails.
pub fn seal(src: &Path, dst: &Path, password: &str) -> Result<(), SealError> {
    seal_with(src, dst, password, DEFAULT_COST)
}

pub fn seal_with(src: &Path, dst: &Path, password: &str, cost: Cost) -> Result<(), SealError> {
    let run = || -> Result<(), SealError> {
        let mut header = [0u8; HEADER_LEN];
        header[..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&cost.m_kib.to_le_bytes());
        header[12..16].copy_from_slice(&cost.t.to_le_bytes());
        header[16..20].copy_from_slice(&cost.p.to_le_bytes());
        getrandom::fill(&mut header[20..]).map_err(|_| SealError::Kdf)?;
        let (salt, prefix) = header[20..].split_at(SALT_LEN);
        let mut key = derive(password, salt, cost)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| SealError::Kdf)?;
        key.zeroize();

        let mut input = std::io::BufReader::new(std::fs::File::open(src)?);
        let mut out = std::io::BufWriter::new(std::fs::File::create(dst)?);
        out.write_all(&header)?;
        // one chunk of look-ahead decides which chunk is the last
        let mut cur = vec![0u8; CHUNK];
        let mut next = vec![0u8; CHUNK];
        let mut cur_len = read_full(&mut input, &mut cur)?;
        let mut index = 0u32;
        loop {
            let next_len = if cur_len == CHUNK {
                read_full(&mut input, &mut next)?
            } else {
                0
            };
            let last = next_len == 0;
            let sealed = cipher
                .encrypt(
                    Nonce::from_slice(&nonce(prefix, index, last)),
                    Payload {
                        msg: &cur[..cur_len],
                        aad: &header,
                    },
                )
                .map_err(|_| SealError::Corrupt)?;
            out.write_all(&(sealed.len() as u32).to_le_bytes())?;
            out.write_all(&sealed)?;
            if last {
                break;
            }
            std::mem::swap(&mut cur, &mut next);
            cur_len = next_len;
            index = index.checked_add(1).ok_or(SealError::Corrupt)?;
        }
        out.flush()?;
        Ok(())
    };
    run().inspect_err(|_| {
        let _ = std::fs::remove_file(dst);
    })
}

/// Decrypt a sealed backup into `dst`. `dst` is removed again if anything fails.
pub fn unseal(src: &Path, dst: &Path, password: &str) -> Result<(), SealError> {
    let run = || -> Result<(), SealError> {
        let mut input = std::io::BufReader::new(std::fs::File::open(src)?);
        let mut header = [0u8; HEADER_LEN];
        if read_full(&mut input, &mut header)? != HEADER_LEN || &header[..8] != MAGIC {
            return Err(SealError::NotSealed);
        }
        let word = |at: usize| u32::from_le_bytes(header[at..at + 4].try_into().unwrap());
        let cost = Cost {
            m_kib: word(8),
            t: word(12),
            p: word(16),
        };
        if cost.m_kib > MAX_COST.m_kib || cost.t > MAX_COST.t || cost.p > MAX_COST.p {
            return Err(SealError::Corrupt);
        }
        let (salt, prefix) = header[20..].split_at(SALT_LEN);
        let mut key = derive(password, salt, cost).map_err(|_| SealError::Corrupt)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| SealError::Kdf)?;
        key.zeroize();

        let mut out = std::io::BufWriter::new(std::fs::File::create(dst)?);
        let mut len_buf = [0u8; 4];
        if read_full(&mut input, &mut len_buf)? != 4 {
            return Err(SealError::Corrupt);
        }
        let mut index = 0u32;
        loop {
            let len = u32::from_le_bytes(len_buf) as usize;
            if !(TAG_LEN..=CHUNK + TAG_LEN).contains(&len) {
                return Err(SealError::Corrupt);
            }
            let mut sealed = vec![0u8; len];
            if read_full(&mut input, &mut sealed)? != len {
                return Err(SealError::Corrupt);
            }
            // nothing after this record → it must have been sealed as the last one
            let last = match read_full(&mut input, &mut len_buf)? {
                0 => true,
                4 => false,
                _ => return Err(SealError::Corrupt),
            };
            let plain = cipher
                .decrypt(
                    Nonce::from_slice(&nonce(prefix, index, last)),
                    Payload {
                        msg: &sealed,
                        aad: &header,
                    },
                )
                .map_err(|_| {
                    if index == 0 {
                        SealError::WrongPassword
                    } else {
                        SealError::Corrupt
                    }
                })?;
            out.write_all(&plain)?;
            if last {
                break;
            }
            index = index.checked_add(1).ok_or(SealError::Corrupt)?;
        }
        out.flush()?;
        Ok(())
    };
    run().inspect_err(|_| {
        let _ = std::fs::remove_file(dst);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// small cost so the tests stay fast in debug builds
    const FAST: Cost = Cost {
        m_kib: 64,
        t: 1,
        p: 1,
    };

    fn round_trip(len: usize) {
        let dir = tempfile::tempdir().unwrap();
        let (plain, sealed, back) = (
            dir.path().join("a.zip"),
            dir.path().join("a.tmbackup"),
            dir.path().join("b.zip"),
        );
        let data: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
        std::fs::write(&plain, &data).unwrap();
        seal_with(&plain, &sealed, "correct horse", FAST).unwrap();
        assert!(is_sealed(&sealed) && !is_sealed(&plain));
        unseal(&sealed, &back, "correct horse").unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data, "len {len}");
    }

    #[test]
    fn round_trips_at_chunk_boundaries() {
        for len in [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK] {
            round_trip(len);
        }
    }

    #[test]
    fn plaintext_does_not_appear_in_the_sealed_file() {
        let dir = tempfile::tempdir().unwrap();
        let (plain, sealed) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&plain, b"the quick brown fox jumps over the lazy dog").unwrap();
        seal_with(&plain, &sealed, "pw", FAST).unwrap();
        let bytes = std::fs::read(&sealed).unwrap();
        assert!(!bytes.windows(9).any(|w| w == b"brown fox"));
    }

    #[test]
    fn wrong_password_truncation_and_tampering_fail_and_leave_no_output() {
        let dir = tempfile::tempdir().unwrap();
        let (plain, sealed, back, bad) = (
            dir.path().join("a"),
            dir.path().join("b"),
            dir.path().join("c"),
            dir.path().join("d"),
        );
        std::fs::write(&plain, vec![7u8; 2 * CHUNK + 5]).unwrap();
        seal_with(&plain, &sealed, "right", FAST).unwrap();
        assert!(matches!(
            unseal(&sealed, &back, "wrong"),
            Err(SealError::WrongPassword)
        ));
        assert!(!back.exists());

        let bytes = std::fs::read(&sealed).unwrap();
        // drop the last record: the one before it was not sealed as "last"
        let record = 4 + CHUNK + TAG_LEN;
        std::fs::write(&bad, &bytes[..HEADER_LEN + 2 * record]).unwrap();
        assert!(matches!(
            unseal(&bad, &back, "right"),
            Err(SealError::Corrupt)
        ));
        // swap the first two records
        let mut swapped = bytes.clone();
        let (a, b) = swapped[HEADER_LEN..HEADER_LEN + 2 * record].split_at_mut(record);
        a.swap_with_slice(b);
        std::fs::write(&bad, &swapped).unwrap();
        assert!(unseal(&bad, &back, "right").is_err());
        // flip one bit in the last record
        let mut flipped = bytes.clone();
        *flipped.last_mut().unwrap() ^= 1;
        std::fs::write(&bad, &flipped).unwrap();
        assert!(matches!(
            unseal(&bad, &back, "right"),
            Err(SealError::Corrupt)
        ));
        // a forged header asking for absurd memory is refused before any work
        let mut greedy = bytes.clone();
        greedy[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&bad, &greedy).unwrap();
        assert!(matches!(
            unseal(&bad, &back, "right"),
            Err(SealError::Corrupt)
        ));
        assert!(!back.exists());
        assert!(matches!(
            unseal(&plain, &back, "right"),
            Err(SealError::NotSealed)
        ));
    }
}
