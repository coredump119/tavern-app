use tm_keys::{mask_secret, KeyringBackend, KeysError, MemoryBackend, SecretRef, SecretVault};

fn vault() -> SecretVault<MemoryBackend> {
    SecretVault::new(MemoryBackend::new())
}

#[test]
fn write_read_rotate_delete_follow_st_semantics() {
    let v = vault();
    assert_eq!(v.read("api_key_openai", None).unwrap(), None);
    let a = v
        .write("api_key_openai", "sk-aaaaaaaaaaaa", Some("work"))
        .unwrap();
    let b = v.write("api_key_openai", "sk-bbbbbbbbbbbb", None).unwrap();
    // 新写入的是 active
    assert_eq!(
        v.read("api_key_openai", None).unwrap().as_deref(),
        Some("sk-bbbbbbbbbbbb")
    );
    assert_eq!(
        v.read("api_key_openai", Some(&a)).unwrap().as_deref(),
        Some("sk-aaaaaaaaaaaa")
    );
    let metas = v.find("api_key_openai").unwrap();
    assert_eq!(metas.len(), 2);
    assert_eq!(
        (
            metas[0].label.as_str(),
            metas[0].active,
            metas[0].masked.as_str()
        ),
        ("work", false, "*******aaa")
    );
    assert_eq!(
        (metas[1].label.as_str(), metas[1].active),
        ("Unlabeled", true)
    );
    v.rotate("api_key_openai", &a).unwrap();
    assert_eq!(
        v.read("api_key_openai", None).unwrap().as_deref(),
        Some("sk-aaaaaaaaaaaa")
    );
    // 删 active → 剩下的最后一把变 active
    v.delete("api_key_openai", &a).unwrap();
    assert_eq!(
        v.read("api_key_openai", None).unwrap().as_deref(),
        Some("sk-bbbbbbbbbbbb")
    );
    assert!(matches!(
        v.delete("api_key_openai", "nope"),
        Err(KeysError::NotFound(_))
    ));
    v.delete("api_key_openai", &b).unwrap();
    assert_eq!(v.find("api_key_openai").unwrap(), vec![]);
    assert!(!v.state().unwrap()["api_key_openai"]);
    assert!(matches!(
        v.write("not_a_key", "x", None),
        Err(KeysError::UnknownKey(_))
    ));
}

#[test]
fn proxy_passwords_by_preset_and_resolve() {
    let v = vault();
    v.set_proxy_password("home", "pw-home-0000").unwrap();
    v.set_proxy_password("work", "pw-work").unwrap();
    v.set_proxy_password("home", "pw-home-1111").unwrap();
    assert_eq!(
        v.proxy_password("home").unwrap().as_deref(),
        Some("pw-home-1111")
    );
    assert_eq!(
        v.proxy_password("work").unwrap().as_deref(),
        Some("pw-work")
    );
    assert_eq!(v.find("proxy_password").unwrap().len(), 2);
    assert_eq!(
        v.resolve(&SecretRef::ProxyPassword {
            preset: "work".into()
        })
        .unwrap()
        .as_deref(),
        Some("pw-work")
    );
    assert_eq!(
        v.resolve(&SecretRef::Keyring {
            key: "api_key_claude".into(),
            id: None
        })
        .unwrap(),
        None
    );
    assert_eq!(v.resolve(&SecretRef::None).unwrap(), None);
    assert!(v.state().unwrap()["proxy_password"]);
}

#[test]
fn masking_matches_st() {
    assert_eq!(mask_secret("short", "api_key_openai"), "**********");
    assert_eq!(mask_secret("exactly10c", "api_key_openai"), "**********");
    assert_eq!(
        mask_secret("sk-1234567890abc", "api_key_openai"),
        "*******abc"
    );
    assert_eq!(mask_secret("http://x", "libre_url"), "http://x");
}

#[test]
fn keyring_backend_over_mock_store() {
    keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
    let v = SecretVault::new(KeyringBackend::new("dev.coredump119.tavern.test"));
    assert_eq!(v.backend_kind(), "keyring");
    let id = v
        .write("api_key_deepseek", "ds-key-value", Some("l"))
        .unwrap();
    assert_eq!(
        v.read("api_key_deepseek", None).unwrap().as_deref(),
        Some("ds-key-value")
    );
    v.delete("api_key_deepseek", &id).unwrap();
    assert_eq!(v.read("api_key_deepseek", None).unwrap(), None);
    // 删不存在的条目不报错
    v.delete("api_key_deepseek", &id).unwrap_err();
}

#[test]
fn rename_changes_only_the_label() {
    let v = vault();
    let a = v.write("api_key_custom", "sk-aaaaaaaaaaaa", None).unwrap();
    let b = v.write("api_key_custom", "sk-bbbbbbbbbbbb", None).unwrap();
    v.rename("api_key_custom", &a, "备用").unwrap();
    let metas = v.find("api_key_custom").unwrap();
    assert_eq!(
        (metas[0].label.as_str(), metas[0].active, metas[0].id == a),
        ("备用", false, true)
    );
    assert_eq!(
        (metas[1].label.as_str(), metas[1].active, metas[1].id == b),
        ("Unlabeled", true, true)
    );
    assert_eq!(
        v.read("api_key_custom", Some(&a)).unwrap().as_deref(),
        Some("sk-aaaaaaaaaaaa")
    );
    assert!(matches!(
        v.rename("api_key_custom", "missing", "x"),
        Err(KeysError::NotFound(_))
    ));
}
