fn main() {
    // bundle.resources must exist when tauri_build validates the config, but
    // several entries are gitignored build artifacts: ../../web/build-node
    // (npm run build:node), resources/node (fetch-bundled-assets.sh) and the
    // single-file helpers resources/{ffmpeg,ffprobe,lfai-render} (same script,
    // LIGHTWEIGHT mode). cargo check/test on a fresh clone runs before either
    // generator, so create placeholders — real content is produced by
    // beforeBuildCommand / the fetch step before anything is actually bundled.
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let resources = manifest.join("resources");

    for dir in [
        manifest.join("../../web/build-node"),
        resources.join("node"),
    ] {
        if !dir.exists() {
            let _ = std::fs::create_dir_all(dir);
        }
    }

    // tauri_build resolves `./resources/lfai-render*` (also ffmpeg*/ffprobe*) as
    // files and fails with "Is a directory (os error 21)" when ANY match is a
    // directory. The glob is the trap: on macOS a `lfai-render.dSYM` directory
    // also matches, and on CI a partially-applied fetch can leave a stray dir
    // under the same prefix. Sweep every prefix match, not just the exact name,
    // and say what was found so a repeat failure is diagnosable from the log.
    for prefix in ["ffmpeg", "ffprobe", "lfai-render"] {
        let mut matches: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&resources) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().starts_with(prefix) {
                    matches.push(entry.path());
                }
            }
        }
        matches.sort();
        for path in matches {
            let is_dir = path.is_dir();
            let is_link = std::fs::symlink_metadata(&path)
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
            println!(
                "cargo:warning=resource {}: is_dir={is_dir} is_symlink={is_link}",
                path.display()
            );
            if is_dir || is_link {
                // remove_dir_all follows the shape, not the link; only a real
                // directory needs it, a symlink is removed as a file entry.
                let removed = if is_link {
                    std::fs::remove_file(&path)
                } else {
                    std::fs::remove_dir_all(&path)
                };
                match removed {
                    Ok(()) => println!("cargo:warning=removed non-file {}", path.display()),
                    Err(error) => panic!("cannot clear {}: {error}", path.display()),
                }
            }
        }
        // Guarantee the exact name exists as a regular file for the glob.
        let exact = resources.join(prefix);
        if !exact.is_file() {
            std::fs::File::create(&exact)
                .unwrap_or_else(|error| panic!("cannot create placeholder {prefix}: {error}"));
            println!("cargo:warning=created placeholder file for {prefix}");
        }
    }

    tauri_build::build()
}
