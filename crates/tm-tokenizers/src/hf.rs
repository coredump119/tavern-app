//! HuggingFace tokenizer.json 注册表：按名字登记路径，首次使用时加载并缓存。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokenizers::Tokenizer;

use crate::{Result, TokenizerError};

#[derive(Default)]
pub struct HfRegistry {
    paths: Mutex<HashMap<String, PathBuf>>,
    loaded: Mutex<HashMap<String, Arc<Tokenizer>>>,
}

impl HfRegistry {
    pub fn register(&self, name: &str, path: impl Into<PathBuf>) {
        self.paths
            .lock()
            .unwrap()
            .insert(name.to_string(), path.into());
        self.loaded.lock().unwrap().remove(name);
    }

    pub fn registered(&self) -> Vec<String> {
        let mut v: Vec<String> = self.paths.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }

    /// 返回 None 表示没有登记（调用方回退估算）；登记了但加载失败则报错。
    pub fn get(&self, name: &str) -> Result<Option<Arc<Tokenizer>>> {
        if let Some(t) = self.loaded.lock().unwrap().get(name) {
            return Ok(Some(t.clone()));
        }
        let path = match self.paths.lock().unwrap().get(name) {
            Some(p) => p.clone(),
            None => return Ok(None),
        };
        let tok = Tokenizer::from_file(&path)
            .map_err(|e| TokenizerError::Hf(format!("{}: {e}", path.display())))?;
        let arc = Arc::new(tok);
        self.loaded
            .lock()
            .unwrap()
            .insert(name.to_string(), arc.clone());
        Ok(Some(arc))
    }
}

pub fn encode(tok: &Tokenizer, text: &str) -> Result<Vec<u32>> {
    // web-tokenizers 的 encode 不加特殊 token
    let enc = tok
        .encode(text, false)
        .map_err(|e| TokenizerError::Hf(e.to_string()))?;
    Ok(enc.get_ids().to_vec())
}

pub fn decode(tok: &Tokenizer, ids: &[u32]) -> Result<String> {
    tok.decode(ids, false)
        .map_err(|e| TokenizerError::Hf(e.to_string()))
}
