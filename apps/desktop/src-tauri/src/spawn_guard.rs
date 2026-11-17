//! Child processes must not outlive the app by accident: a SIGKILL (OOM
//! killer, force-quit) skips every Drop handler, so grouped spawns and cancel
//! paths alone still leave build-node / whisper / ffmpeg / RAG trees running
//! and eating RAM. PR_SET_PDEATHSIG makes the kernel kill each direct child
//! the moment the app dies; grandchildren follow because their parent dies
//! and their stdout pipe closes. Windows keeps its Job Object handling.

use std::process::Command;

/// Applies PR_SET_PDEATHSIG (SIGKILL) on Linux. Call before `spawn()`/`group()`.
pub(crate) fn set_parent_death_sig(cmd: &mut Command) {
    // Linux only: prctl has no macOS/BSD equivalent and the release workflow
    // builds on macOS, where the previous cfg(unix) failed to compile.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let app_pid = std::process::id();
        // pre_exec runs in the forked child right before exec: prctl and
        // getppid are async-signal-safe, so this closure stays minimal.
        unsafe {
            cmd.pre_exec(move || {
                const PR_SET_PDEATHSIG: libc::c_int = 1;
                if libc::prctl(PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Close the fork/prctl race: if the app died in between, die too.
                if libc::getppid() as u32 != app_pid {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard must not break normal spawns: the child runs, exits cleanly,
    /// and is reaped while the app (its parent) stays alive.
    #[test]
    fn guarded_child_runs_normally() {
        let mut cmd = Command::new("true");
        set_parent_death_sig(&mut cmd);
        let status = cmd.status().expect("guarded spawn must work");
        assert!(status.success());
    }
}
