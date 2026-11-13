//! Chunk-level PNG access (no pixels). Validates signature, lengths and CRCs on read.

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

#[derive(Debug, thiserror::Error)]
pub enum PngError {
    #[error("not a PNG (bad signature)")]
    Signature,
    #[error("truncated chunk {0}")]
    Truncated(String),
    #[error("crc mismatch in chunk {0}")]
    Crc(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub kind: [u8; 4],
    pub data: Vec<u8>,
}

fn kind_str(kind: &[u8; 4]) -> String {
    String::from_utf8_lossy(kind).into_owned()
}

pub fn read_chunks(bytes: &[u8]) -> Result<Vec<Chunk>, PngError> {
    if bytes.len() < 8 || bytes[..8] != SIGNATURE {
        return Err(PngError::Signature);
    }
    let mut chunks = Vec::new();
    let mut pos = 8;
    while pos + 8 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = bytes[pos + 4..pos + 8].try_into().unwrap();
        let start = pos + 8;
        let end = start + len;
        if end + 4 > bytes.len() {
            return Err(PngError::Truncated(kind_str(&kind)));
        }
        let data = &bytes[start..end];
        let crc = u32::from_be_bytes(bytes[end..end + 4].try_into().unwrap());
        let mut h = crc32fast::Hasher::new();
        h.update(&kind);
        h.update(data);
        if h.finalize() != crc {
            return Err(PngError::Crc(kind_str(&kind)));
        }
        chunks.push(Chunk {
            kind,
            data: data.to_vec(),
        });
        pos = end + 4;
        if kind == *b"IEND" {
            break;
        }
    }
    Ok(chunks)
}

pub fn write_chunks(chunks: &[Chunk]) -> Vec<u8> {
    let total = 8 + chunks.iter().map(|c| 12 + c.data.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&SIGNATURE);
    for c in chunks {
        out.extend_from_slice(&(c.data.len() as u32).to_be_bytes());
        out.extend_from_slice(&c.kind);
        out.extend_from_slice(&c.data);
        let mut h = crc32fast::Hasher::new();
        h.update(&c.kind);
        h.update(&c.data);
        out.extend_from_slice(&h.finalize().to_be_bytes());
    }
    out
}

/// tEXt payload → (keyword, text). Keyword is Latin-1 in the spec; ST only uses ASCII keys.
pub fn split_text(data: &[u8]) -> Option<(String, &[u8])> {
    let nul = data.iter().position(|&b| b == 0)?;
    let keyword = data[..nul].iter().map(|&b| b as char).collect();
    Some((keyword, &data[nul + 1..]))
}

pub fn text_chunk(keyword: &str, text: &str) -> Chunk {
    let mut data = Vec::with_capacity(keyword.len() + 1 + text.len());
    data.extend_from_slice(keyword.as_bytes());
    data.push(0);
    data.extend_from_slice(text.as_bytes());
    Chunk {
        kind: *b"tEXt",
        data,
    }
}
