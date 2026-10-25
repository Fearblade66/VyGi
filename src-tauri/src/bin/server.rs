//! VyGi web server (the Docker image's entry point).

#[tokio::main]
async fn main() {
    let result = match vygi_lib::server::Config::from_env() {
        Ok(cfg) => vygi_lib::server::run(cfg).await,
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        eprintln!("VyGi web server failed: {e}");
        std::process::exit(1);
    }
}
