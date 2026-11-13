use serde_json::json;
use tm_tokenizers::{
    count_tiktoken_messages, guesstimate, openai_tokenizer_model, resolve_tokenizer_model,
    Encoding, TokenizerModel, TokenizerService,
};

#[test]
fn guesstimate_matches_st_bytes_ratio() {
    assert_eq!(guesstimate(""), 0);
    assert_eq!(guesstimate("hello world"), (11.0f64 / 3.35).ceil() as usize);
    assert_eq!(guesstimate("你好"), (6.0f64 / 3.35).ceil() as usize);
}

#[test]
fn encoding_for_model_follows_tiktoken_npm_table() {
    assert_eq!(Encoding::for_openai_model("gpt-4"), Some(Encoding::Cl100k));
    assert_eq!(Encoding::for_openai_model("gpt-4o"), Some(Encoding::O200k));
    assert_eq!(Encoding::for_openai_model("o1"), Some(Encoding::O200k));
    assert_eq!(Encoding::for_openai_model("gpt-5"), Some(Encoding::O200k));
    assert_eq!(Encoding::for_openai_model("gpt2"), Some(Encoding::Gpt2));
    assert_eq!(
        Encoding::for_openai_model("text-davinci-003"),
        Some(Encoding::P50k)
    );
    assert_eq!(
        Encoding::for_openai_model("text-davinci-edit-001"),
        Some(Encoding::P50kEdit)
    );
    assert_eq!(Encoding::for_openai_model("claude"), None);
}

#[test]
fn server_model_mapping() {
    assert_eq!(openai_tokenizer_model("gpt-4o-mini-2024-07-18"), "gpt-4o");
    assert_eq!(openai_tokenizer_model("gpt-4.1-nano"), "gpt-4o");
    assert_eq!(openai_tokenizer_model("gpt-4-turbo"), "gpt-4");
    assert_eq!(openai_tokenizer_model("gpt-4-32k-0613"), "gpt-4-32k");
    assert_eq!(openai_tokenizer_model("o3-mini"), "o1");
    assert_eq!(
        openai_tokenizer_model("gpt-3.5-turbo-0301"),
        "gpt-3.5-turbo-0301"
    );
    assert_eq!(
        openai_tokenizer_model("text-davinci-003"),
        "text-davinci-003"
    );
    assert_eq!(openai_tokenizer_model("claude-sonnet-4-5"), "claude");
    assert_eq!(openai_tokenizer_model("meta-llama/llama-3-70b"), "llama3");
    assert_eq!(openai_tokenizer_model("mistral-large"), "mistral");
    assert_eq!(openai_tokenizer_model("gemini-2.5-pro"), "gemma");
    assert_eq!(openai_tokenizer_model("totally-unknown"), "gpt-3.5-turbo");
    assert_eq!(
        resolve_tokenizer_model("claude-3"),
        TokenizerModel::Local("claude".into())
    );
    assert_eq!(
        resolve_tokenizer_model("gpt-4o"),
        TokenizerModel::Tiktoken("gpt-4o".into())
    );
}

#[test]
fn tiktoken_encode_decode_and_counts() {
    let svc = TokenizerService::new();
    let r = svc.encode("openai", Some("gpt-4"), "hello world").unwrap();
    assert_eq!(r.count, 2);
    assert_eq!(
        svc.decode("openai", Some("gpt-4"), &r.ids).unwrap(),
        "hello world"
    );
    let g = svc.encode("gpt2", None, "hello world").unwrap();
    assert_eq!(g.count, 2);
    assert_eq!(
        svc.count("openai", Some("gpt-4o"), "你好，世界").unwrap(),
        svc.encode("openai", Some("gpt-4o"), "你好，世界")
            .unwrap()
            .ids
            .len()
    );
    // 服务端 /openai/count：每条 3 + Σ字段 + name 1 + 整次 3
    let msgs = vec![json!({"role": "user", "content": "hello world"})];
    assert_eq!(count_tiktoken_messages("gpt-4", &msgs), 3 + 1 + 2 + 3);
    let named = vec![json!({"role": "user", "content": "hello world", "name": "x"})];
    assert_eq!(
        count_tiktoken_messages("gpt-4", &named),
        3 + 1 + 2 + 1 + 1 + 3
    );
    assert_eq!(
        count_tiktoken_messages("gpt-3.5-turbo-0301", &msgs),
        4 + 1 + 2 + 3 + 9
    );
    assert_eq!(svc.count_openai_messages("gpt-4-turbo", &msgs).unwrap(), 9);
}

#[test]
fn hf_registry_loads_lazily_and_falls_back_to_estimate() {
    let svc = TokenizerService::new();
    // 未登记 → sentencepiece/web 路径回退估算
    assert_eq!(
        svc.count("llama", None, "hello world").unwrap(),
        guesstimate("hello world")
    );
    assert!(svc.decode("llama", None, &[1]).is_err());
    assert!(svc.encode("nope", None, "x").is_err());

    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-tokenizer.json");
    svc.register_hf("claude", &path);
    assert_eq!(svc.hf().registered(), vec!["claude".to_string()]);
    let r = svc.encode("claude", None, "Hello world").unwrap();
    assert_eq!(r.ids, vec![1, 2]);
    assert_eq!(svc.decode("claude", None, &r.ids).unwrap(), "hello world");

    // /openai/count 的 claude 分支：先转 Claude 文本再数（"\n\nHuman: hello" 等）
    let msgs = vec![
        json!({"role": "system", "content": "hello"}),
        json!({"role": "user", "content": "world"}),
        json!({"role": "assistant", "content": "hi"}),
    ];
    let n = svc.count_openai_messages("claude-3-opus", &msgs).unwrap();
    // 文本: "\n\nHuman: hello" + "\n\nFirst message: world" + "\n\nAssistant: hi" → tokens: human : hello | [UNK] [UNK] : world | assistant : hi
    assert_eq!(n, 3 + 4 + 3);
    assert_eq!(
        svc.count_openai_messages("mistral-large", &msgs).unwrap(),
        guesstimate("system\n\nhello\n\nuser\n\nworld\n\nassistant\n\nhi")
    );
    // 登记了但文件不存在 → 报错
    svc.register_hf("qwen2", "/nonexistent/qwen2.json");
    assert!(svc.count("qwen2", None, "x").is_err());
}

#[test]
fn claude_prompt_conversion_matches_st_old_format() {
    use tm_tokenizers::claude::convert_claude_prompt;
    let msgs = vec![
        json!({"role": "system", "content": "sys"}),
        json!({"role": "system", "content": "ex", "name": "example_user"}),
        json!({"role": "system", "content": "exa", "name": "example_assistant"}),
        json!({"role": "user", "content": "u1"}),
        json!({"role": "user", "content": "u2", "name": "Yun"}),
        json!({"role": "assistant", "content": "a1"}),
        json!({"role": "tool", "content": "t"}),
    ];
    assert_eq!(convert_claude_prompt(&msgs), "\n\nHuman: sys\n\nH: ex\n\nA: exa\n\nHuman: u1\n\nFirst message: Yun: u2\n\nAssistant: a1t");
    assert_eq!(convert_claude_prompt(&[]), "");
    assert_eq!(
        convert_claude_prompt(&[json!({"role": "assistant", "content": "only"})]),
        "\n\nHuman: only"
    );
}
