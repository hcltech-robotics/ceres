use std::{env, fs, path::PathBuf};

fn main() {
    let metadata =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../package.json");
    println!("cargo:rerun-if-changed={}", metadata.display());
    let package: serde_json::Value =
        serde_json::from_slice(&fs::read(metadata).expect("root release metadata is required"))
            .expect("root release metadata must be JSON");
    let version = package["version"]
        .as_str()
        .expect("root release version is required");
    assert!(
        !version.is_empty()
            && version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte)),
        "root release version contains invalid characters"
    );
    println!("cargo:rustc-env=CERES_RELEASE_VERSION={version}");
}
