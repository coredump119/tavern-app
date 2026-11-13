#[derive(Debug, thiserror::Error)]
pub enum KeysError {
    #[error("credential store unavailable: {0}")]
    StoreUnavailable(String),
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unknown secret key: {0}")]
    UnknownKey(String),
    #[error("secret not found: {0}")]
    NotFound(String),
}

impl From<keyring_core::Error> for KeysError {
    fn from(e: keyring_core::Error) -> Self {
        match e {
            keyring_core::Error::NoDefaultStore => {
                KeysError::StoreUnavailable("no default store".into())
            }
            other => KeysError::Keyring(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, KeysError>;
