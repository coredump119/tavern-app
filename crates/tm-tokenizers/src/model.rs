//! ST 服务端 `getTokenizerModel(requestModel)` 的移植：把任意模型名归一到 tiktoken 模型名或本地分词器名。

/// 服务端 TEXT_COMPLETION_MODELS
pub fn text_completion_models() -> &'static [String] {
    static LIST: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    LIST.get_or_init(|| {
        serde_json::from_str(include_str!("../data/text_completion_models.json"))
            .expect("text_completion_models.json")
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenizerModel {
    /// 走 tiktoken 的 OpenAI 模型名（如 gpt-4、gpt-4o、o1、gpt-3.5-turbo）
    Tiktoken(String),
    /// 本地 HF / sentencepiece 分词器名（claude、llama3、llama、mistral…）
    Local(String),
}

/// 对应服务端 getTokenizerModel 返回的字符串
pub fn openai_tokenizer_model(request_model: &str) -> String {
    let m = request_model;
    if m == "o1" || m.contains("o1-preview") || m.contains("o1-mini") || m.contains("o3-mini") {
        return "o1".into();
    }
    if m.contains("gpt-5") || m.contains("o3") || m.contains("o4-mini") {
        return "o1".into();
    }
    if m.contains("gpt-4o") || m.contains("chatgpt-4o-latest") {
        return "gpt-4o".into();
    }
    if m.contains("gpt-4.1") || m.contains("gpt-4.5") {
        return "gpt-4o".into();
    }
    if m.contains("gpt-4-32k") {
        return "gpt-4-32k".into();
    }
    if m.contains("gpt-4") {
        return "gpt-4".into();
    }
    if m.contains("gpt-3.5-turbo-0301") {
        return "gpt-3.5-turbo-0301".into();
    }
    if m.contains("gpt-3.5-turbo") {
        return "gpt-3.5-turbo".into();
    }
    if text_completion_models().iter().any(|x| x == m) {
        return m.into();
    }
    if m.contains("claude") {
        return "claude".into();
    }
    if m.contains("llama3") || m.contains("llama-3") {
        return "llama3".into();
    }
    if m.contains("llama") {
        return "llama".into();
    }
    if m.contains("mistral") {
        return "mistral".into();
    }
    if m.contains("yi") {
        return "yi".into();
    }
    if m.contains("deepseek") {
        return "deepseek".into();
    }
    if m.contains("gemma") || m.contains("gemini") || m.contains("learnlm") {
        return "gemma".into();
    }
    if m.contains("jamba") {
        return "jamba".into();
    }
    if m.contains("qwen2") {
        return "qwen2".into();
    }
    if m.contains("command-r") {
        return "command-r".into();
    }
    if m.contains("command-a") {
        return "command-a".into();
    }
    if m.contains("nemo") {
        return "nemo".into();
    }
    "gpt-3.5-turbo".into()
}

pub fn resolve_tokenizer_model(request_model: &str) -> TokenizerModel {
    let name = openai_tokenizer_model(request_model);
    match name.as_str() {
        "claude" | "llama3" | "llama" | "mistral" | "yi" | "deepseek" | "gemma" | "jamba"
        | "qwen2" | "command-r" | "command-a" | "nemo" => TokenizerModel::Local(name),
        _ => TokenizerModel::Tiktoken(name),
    }
}
