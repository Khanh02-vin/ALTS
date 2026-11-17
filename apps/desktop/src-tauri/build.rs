fn main() {
    // bundle.resources must exist when tauri_build validates the config, but
    // several entries are gitignored build artifacts: ../../web/build-node
    // (npm run build:node), resources/node (fetch-bundled-assets.sh) and the
    // single-file helpers resources/{ffmpeg,ffprobe,lfai-render} (same script,
    // LIGHTWEIGHT mode). cargo check/test on a fresh clone runs before either
    // generator, so create placeholders — real content is produced by
    // beforeBuildCommand / the fetch step before anything is actually bundled.
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

    for dir in [
        manifest.join("../../web/build-node"),
        manifest.join("resources/node"),
    ] {
        if !dir.exists() {
            let _ = std::fs::create_dir_all(dir);
        }
    }

    // tauri_build resolves `./resources/lfai-render*` (also ffmpeg/ffprobe) as
    // *files* and fails with "Is a directory (os error 21)" when the path exists
    // as a directory instead — which is what a partially-run fetch or a stray
    // mkdir leaves behind on CI. Repair the shape here so the build no longer
    // depends on which generator ran first.
    for file in [
        "resources/ffmpeg",
        "resources/ffprobe",
        "resources/lfai-render",
    ] {
        let path = manifest.join(file);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        }
        if !path.exists() {
            let _ = std::fs::File::create(&path);
        }
    }

    tauri_build::build()
}
