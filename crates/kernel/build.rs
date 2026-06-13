use std::process::Command;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=RUFLO_KERNEL_TARGET={target}");

    let sha = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .and_then(|o| if o.status.success() { String::from_utf8(o.stdout).ok() } else { None })
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=RUFLO_KERNEL_GIT_SHA={sha}");

    println!("cargo:rerun-if-changed=src/");
    println!("cargo:rerun-if-env-changed=TARGET");
}
