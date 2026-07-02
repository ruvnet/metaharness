use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "rvface", about = "rvFACE: Rust face recognition (port of Faceplugin Open-Source-Face-Recognition-SDK)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Detect faces in an image and print boxes/landmarks/pose as JSON
    Detect { image: String },
    /// Compare the primary face of two images; prints score (0-100) and verdict at threshold 75
    Compare { image_a: String, image_b: String },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Detect { image } => anyhow::bail!("not yet implemented: detect {image}"),
        Command::Compare { image_a, image_b } => {
            anyhow::bail!("not yet implemented: compare {image_a} {image_b}")
        }
    }
}
