fn main() {
    // The web server build has no Tauri app to configure.
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build()
    }
}
