//! `tm-data` — the data layer as a CLI, for scripts and the st-oracle round-trip test.
//!
//!   tm-data layout <root>
//!   tm-data export <root> <zip> [--with-secrets]
//!   tm-data import <zip> <root>
//!   tm-data index rebuild|scan|characters|search <root> [query]
//!   tm-data bench-chat [rows]        # Phase 4 budget: 3000-message chat read_tail < 200ms (DEV_NOTES §9.31)

use std::path::Path;
use std::process::ExitCode;

fn out<T: serde::Serialize>(v: &T) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

fn usage() -> ExitCode {
    eprintln!("usage: tm-data layout <root> | export <root> <zip> [--with-secrets] | import <zip> <root> | index <rebuild|scan|characters|search> <root> [query] | bench-chat [rows]");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r: Result<(), Box<dyn std::error::Error>> = (|| {
        match args
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["layout", root] => {
                tm_data::layout::ensure_layout(Path::new(root))?;
                out(&tm_data::layout::DIRS);
            }
            ["export", root, zip, rest @ ..] => {
                let with_secrets = rest.contains(&"--with-secrets");
                out(&tm_data::archive::export(
                    Path::new(root),
                    Path::new(zip),
                    with_secrets,
                )?);
            }
            ["import", zip, root] => {
                let mut rep = tm_data::archive::import(Path::new(zip), Path::new(root))?;
                rep.secrets = rep
                    .secrets
                    .map(|_| serde_json::json!("<captured, not printed>"));
                out(&rep);
            }
            ["index", "rebuild", root] => {
                out(&tm_data::index::Index::open(Path::new(root))?.rebuild()?)
            }
            ["index", "scan", root] => out(&tm_data::index::Index::open(Path::new(root))?.scan()?),
            ["index", "characters", root] => {
                out(&tm_data::index::Index::open(Path::new(root))?.characters()?)
            }
            ["index", "search", root, query] => {
                out(&tm_data::index::Index::open(Path::new(root))?.search(query, 50)?)
            }
            ["bench-chat", rest @ ..] => {
                let rows: usize = rest.first().and_then(|r| r.parse().ok()).unwrap_or(3000);
                let report = bench_chat(rows)?;
                out(&report);
                if !report.ok {
                    return Err(format!(
                        "bench-chat: read_tail took {:.1}ms, over {:.0}ms",
                        report.read_tail_ms, report.limit_ms
                    )
                    .into());
                }
            }
            _ => return Err("bad arguments".into()),
        }
        Ok(())
    })();
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.to_string() == "bad arguments" => usage(),
        Err(e) => {
            eprintln!("tm-data: {e}");
            ExitCode::FAILURE
        }
    }
}

#[derive(serde::Serialize)]
struct BenchReport {
    rows: usize,
    file_bytes: u64,
    write_ms: f64,
    read_tail_ms: f64,
    append_ms: f64,
    index_scan_ms: f64,
    budget_ms: f64,
    limit_ms: f64,
    ok: bool,
}

/// Synthesize `rows` ST-shaped messages in a temp data root and time the paths a chat open uses.
/// Budget 200ms for `read_tail(100 000)`; the limit is 3× (CI runners, debug builds) unless
/// `BENCH_SLACK` says otherwise.
fn bench_chat(rows: usize) -> Result<BenchReport, Box<dyn std::error::Error>> {
    use std::time::Instant;
    let slack: f64 = std::env::var("BENCH_SLACK")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3.0);
    let budget_ms = 200.0;
    let root = std::env::temp_dir().join(format!(
        "tm-bench-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    tm_data::layout::ensure_layout(&root)?;
    let dir = root.join(tm_data::layout::CHATS).join("Bench");
    let path = dir.join("Bench - 2026-11-08.jsonl");
    let body = "*She looks up from the ledger.* \"You again? Sit down, the tea is still warm.\" The glade was quiet. **Too** quiet.";
    let mut lines = Vec::with_capacity(rows + 1);
    lines.push(
        r#"{"user_name":"Yun","character_name":"Bench","create_date":"2026-11-08@10h00m00s","chat_metadata":{}}"#
            .to_string(),
    );
    for i in 0..rows {
        let user = i % 2 == 1;
        let name = if user { "Yun" } else { "Bench" };
        lines.push(format!(
            r#"{{"name":"{name}","is_user":{user},"is_system":false,"send_date":"2026-11-08 10:{:02}","mes":"{body} (#{i})","extra":{{}}}}"#,
            i % 60
        ));
    }
    let t = Instant::now();
    tm_data::chat::create_chat(&path, &lines)?;
    let write_ms = t.elapsed().as_secs_f64() * 1000.0;
    let file_bytes = std::fs::metadata(&path)?.len();

    let t = Instant::now();
    let tail = tm_data::chat::read_tail(&path, 100_000)?;
    let read_tail_ms = t.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(tail.total, rows);

    let t = Instant::now();
    tm_data::chat::append_message(
        &path,
        r#"{"name":"Yun","is_user":true,"is_system":false,"send_date":"2026-11-08 11:00","mes":"one more","extra":{}}"#,
    )?;
    let append_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = Instant::now();
    tm_data::index::Index::open(&root)?.scan()?;
    let index_scan_ms = t.elapsed().as_secs_f64() * 1000.0;

    let _ = std::fs::remove_dir_all(&root);
    let limit_ms = budget_ms * slack;
    Ok(BenchReport {
        rows,
        file_bytes,
        write_ms,
        read_tail_ms,
        append_ms,
        index_scan_ms,
        budget_ms,
        limit_ms,
        ok: read_tail_ms <= limit_ms,
    })
}
