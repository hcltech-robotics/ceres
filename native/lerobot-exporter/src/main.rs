use std::path::Path;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let result = match args.get(1).map(String::as_str) {
        Some("--version") => {
            println!("ceres-native-exporter {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("--capabilities") => {
            println!(
                "{}",
                serde_json::json!({"schema":"ceres-native-export-capabilities","version":1,"job_version":1,"session_encoding":"ceres-session-v1","lerobot":"v3.0","oracle":"0.6.1","state_dimension":410,"validity_dimension":51,"actions":false})
            );
            return;
        }
        Some("--job") if args.len() == 3 => ceres_native_exporter::run(Path::new(&args[2])),
        _ => Err(anyhow::anyhow!(
            "usage: ceres-native-exporter --job job.json | --capabilities | --version"
        )),
    };
    if let Err(error) = result {
        println!(
            "{}",
            serde_json::json!({"schema":"ceres-export-progress","version":1,"stage":"error","message":format!("{error:#}")})
        );
        std::process::exit(1);
    }
}
