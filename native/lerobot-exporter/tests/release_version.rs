#[test]
fn cli_version_matches_root_release_metadata() {
    let metadata = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    let package: serde_json::Value =
        serde_json::from_slice(&std::fs::read(metadata).unwrap()).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ceres-native-exporter"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!(
            "ceres-native-exporter {}",
            package["version"].as_str().unwrap()
        )
    );
}
