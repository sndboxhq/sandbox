fn main() {
    let contracts = sandbox_engine::node_contracts();
    println!(
        "{}",
        serde_json::to_string_pretty(&contracts)
            .expect("the authoritative node contract registry must serialize")
    );
}
