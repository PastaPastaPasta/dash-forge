//! Live round-trip against the real OS keychain (macOS). Ignored by default: run with
//! `cargo test -p forge-core --test keychain_live -- --ignored`.

#[test]
#[ignore = "touches the real OS keychain"]
fn values_round_trip_including_tabs_and_non_ascii() {
    use forge_core::keychain;
    let acct = format!("live-test/{}", std::process::id());
    for v in ["plain", "tab\there", "café ☕", "{\"k\":\"v\"}"] {
        keychain::set("dash-forge-test", &acct, v).unwrap();
        assert_eq!(
            keychain::get("dash-forge-test", &acct)
                .unwrap()
                .unwrap()
                .expose(),
            v
        );
    }
    assert!(keychain::delete("dash-forge-test", &acct).unwrap());
    assert!(!keychain::delete("dash-forge-test", &acct).unwrap());
    assert!(keychain::get("dash-forge-test", &acct).unwrap().is_none());
}
