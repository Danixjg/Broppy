use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "brain-anchor <publish|verify> --log <audit.jsonl> --pubkey <audit.pub.pem> --anchors <anchors.jsonl>

  publish   verify the log, then append batch roots the anchors file does not have yet
  verify    fail if the log disagrees with the anchors already published

Run publish from a checkout of the separate anchor repository, then commit and push it.";

fn flag(args: &[String], name: &str) -> Option<PathBuf> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(PathBuf::from)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(log), Some(pubkey), Some(anchors)) =
        (flag(&args, "--log"), flag(&args, "--pubkey"), flag(&args, "--anchors"))
    else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let key = match brain_anchor::load_key(&pubkey) {
        Ok(key) => key,
        Err(e) => { eprintln!("{e}"); return ExitCode::from(2); }
    };
    match args.first().map(String::as_str) {
        Some("publish") => match brain_anchor::publish(&log, &key, &anchors) {
            Ok(0) => { println!("anchors are up to date"); ExitCode::SUCCESS }
            Ok(n) => { println!("anchored {n} new batch(es); commit and push the anchors file"); ExitCode::SUCCESS }
            Err(e) => { eprintln!("{e}"); ExitCode::FAILURE }
        },
        Some("verify") => match brain_anchor::verify(&log, &key, &anchors) {
            Ok(n) => { println!("ok: the log matches all {n} anchored batch(es)"); ExitCode::SUCCESS }
            Err(problems) => {
                for p in problems { eprintln!("TAMPERED: {p}"); }
                ExitCode::FAILURE
            }
        },
        _ => { eprintln!("{USAGE}"); ExitCode::from(2) }
    }
}
