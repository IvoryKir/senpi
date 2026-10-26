//! Native receipts for #4199 first publication (design tests 1, 2 and the "Windows native primitive"
//! and "Permission boundary" rows). Windows only; `ci.yml` `socket-secret-native-windows` runs them and
//! prints `RECEIPT_PUBLISH` lines.

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::{publish_no_replace, Publication, PublishError, PublishOutcome};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("senpi-publish-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Every receipt here expects the staging file to be gone, so none may report one left behind.
    fn publish(staging: &str, final_path: &str, bytes: &[u8]) -> Result<PublishOutcome, PublishError> {
        let Publication {
            result,
            staging_left_behind,
        } = publish_no_replace(staging, final_path, bytes);
        assert_eq!(staging_left_behind, None, "staging left behind for {result:?}");
        result
    }

    fn s(path: &Path) -> String {
        path.to_str().expect("utf-8 path").to_string()
    }

    fn only_final(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name().into_string().expect("name"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn publishes_to_an_absent_name_and_removes_nothing_else() {
        let dir = scratch("first");
        let final_path = dir.join("rpc.sock.secret");
        let bytes = [7u8; 32];
        let outcome = publish(&s(&dir.join("rpc.sock.secret.stage-a")), &s(&final_path), &bytes);
        println!("RECEIPT_PUBLISH first outcome={outcome:?}");
        assert_eq!(outcome, Ok(PublishOutcome::Published));
        assert_eq!(std::fs::read(&final_path).expect("read final"), bytes);
        assert_eq!(only_final(&dir), vec!["rpc.sock.secret".to_string()]);
    }

    #[test]
    fn a_collision_keeps_the_winner_and_deletes_only_its_own_staging() {
        let dir = scratch("collision");
        let final_path = dir.join("rpc.sock.secret");
        std::fs::write(&final_path, [1u8; 32]).expect("winner");
        let outcome = publish(
            &s(&dir.join("rpc.sock.secret.stage-b")),
            &s(&final_path),
            &[2u8; 32],
        );
        println!("RECEIPT_PUBLISH collision outcome={outcome:?}");
        assert_eq!(outcome, Ok(PublishOutcome::Collision));
        assert_eq!(std::fs::read(&final_path).expect("read final"), [1u8; 32]);
        assert_eq!(only_final(&dir), vec!["rpc.sock.secret".to_string()]);
    }

    #[test]
    fn a_collision_with_a_reader_holding_the_winner_open_is_still_a_collision() {
        let dir = scratch("reader");
        let final_path = dir.join("rpc.sock.secret");
        std::fs::write(&final_path, [3u8; 32]).expect("winner");
        let reader = std::fs::File::open(&final_path).expect("reader");
        let outcome = publish(
            &s(&dir.join("rpc.sock.secret.stage-c")),
            &s(&final_path),
            &[4u8; 32],
        );
        drop(reader);
        println!("RECEIPT_PUBLISH collision_with_reader outcome={outcome:?}");
        assert_eq!(outcome, Ok(PublishOutcome::Collision));
        assert_eq!(std::fs::read(&final_path).expect("read final"), [3u8; 32]);
    }

    #[test]
    fn concurrent_publishers_produce_exactly_one_winner() {
        const PUBLISHERS: usize = 16;
        let dir = Arc::new(scratch("race"));
        let barrier = Arc::new(Barrier::new(PUBLISHERS));
        let handles: Vec<_> = (0..PUBLISHERS)
            .map(|index| {
                let (dir, barrier) = (Arc::clone(&dir), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    let bytes = [index as u8; 32];
                    barrier.wait();
                    let outcome = publish(
                        &s(&dir.join(format!("rpc.sock.secret.stage-{index}"))),
                        &s(&dir.join("rpc.sock.secret")),
                        &bytes,
                    );
                    (bytes, outcome)
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread"))
            .collect();
        let winners: Vec<_> = results
            .iter()
            .filter(|(_, outcome)| *outcome == Ok(PublishOutcome::Published))
            .collect();
        let collisions = results
            .iter()
            .filter(|(_, outcome)| *outcome == Ok(PublishOutcome::Collision))
            .count();
        println!(
            "RECEIPT_PUBLISH race publishers={PUBLISHERS} winners={} collisions={collisions}",
            winners.len()
        );
        assert_eq!(winners.len(), 1);
        assert_eq!(collisions, PUBLISHERS - 1);
        assert_eq!(
            std::fs::read(dir.join("rpc.sock.secret")).expect("read final"),
            winners[0].0
        );
        assert_eq!(only_final(&dir), vec!["rpc.sock.secret".to_string()]);
    }

    #[test]
    fn an_existing_staging_name_fails_without_touching_the_final_name() {
        let dir = scratch("stage-exists");
        let staging = dir.join("rpc.sock.secret.stage-d");
        std::fs::write(&staging, b"someone else's").expect("staging");
        let outcome = publish(&s(&staging), &s(&dir.join("rpc.sock.secret")), &[5u8; 32]);
        println!("RECEIPT_PUBLISH staging_exists outcome={outcome:?}");
        assert_eq!(
            outcome,
            Err(PublishError::Os {
                step: "create_staging",
                code: 80
            }),
            "ERROR_FILE_EXISTS on the staging name is an error, never a collision"
        );
        assert!(!dir.join("rpc.sock.secret").exists());
        assert_eq!(std::fs::read(&staging).expect("staging kept"), b"someone else's");
    }

    #[test]
    fn the_published_secret_has_a_protected_owner_only_dacl() {
        let dir = scratch("dacl");
        let final_path = dir.join("rpc.sock.secret");
        assert_eq!(
            publish(
                &s(&dir.join("rpc.sock.secret.stage-e")),
                &s(&final_path),
                &[6u8; 32]
            ),
            Ok(PublishOutcome::Published)
        );
        let sddl = dacl_sddl(&final_path);
        let user = current_user_sid();
        println!("RECEIPT_PUBLISH dacl sddl={sddl} user={user}");
        let (flags, aces) = sddl
            .strip_prefix("D:")
            .and_then(|rest| rest.split_once('('))
            .map(|(flags, aces)| (flags.to_string(), format!("({aces}")))
            .unwrap_or_else(|| panic!("not a DACL SDDL: {sddl}"));
        assert!(flags.contains('P'), "DACL must be protected: {sddl}");
        let mut found: Vec<&str> = aces
            .trim_start_matches('(')
            .trim_end_matches(')')
            .split(")(")
            .collect();
        found.sort_unstable();
        assert_eq!(found.len(), 3, "exactly owner, SYSTEM and Administrators: {sddl}");
        for well_known in ["A;;FA;;;BA", "A;;FA;;;SY"] {
            assert!(found.contains(&well_known), "missing {well_known}: {sddl}");
        }
        let owner: Vec<&&str> = found
            .iter()
            .filter(|ace| **ace != "A;;FA;;;BA" && **ace != "A;;FA;;;SY")
            .collect();
        assert!(
            owner.len() == 1 && owner_ace_matches(owner[0], &user),
            "the third ACE grants the current user full access: {sddl}"
        );
    }

    /// The owner ACE grants full access to `user_sid` (an `S-1-...` string).
    fn owner_ace_matches(ace: &str, user_sid: &str) -> bool {
        ace == format!("A;;FA;;;{user_sid}")
    }

    /// senpi#4362: SDDL prints some machine-relative SIDs as aliases, e.g. the built-in local
    /// Administrator (RID 500) as `LA`. An owner ACE printed that way is still the user's ACE.
    #[test]
    fn an_owner_ace_printed_as_an_alias_still_matches_its_sid() {
        let administrator = sid_string_of("LA");
        assert!(
            administrator.starts_with("S-1-5-21-") && administrator.ends_with("-500"),
            "{administrator}"
        );
        println!("RECEIPT_PUBLISH alias_owner LA={administrator}");
        assert!(owner_ace_matches("A;;FA;;;LA", &administrator));
        assert!(!owner_ace_matches("A;;FA;;;SY", &administrator));
        assert!(!owner_ace_matches("A;;GR;;;LA", &administrator));
    }

    /// The `S-1-...` form of an SDDL SID string (alias or numeric).
    fn sid_string_of(sddl_sid: &str) -> String {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
        use windows_sys::Win32::Security::PSID;

        let wide: Vec<u16> = sddl_sid.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sid: PSID = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; `sid` receives a LocalAlloc SID.
        assert_ne!(
            unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) },
            0,
            "not a SID: {sddl_sid}"
        );
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` is valid; `text` receives a LocalAlloc string.
        assert_ne!(
            unsafe { ConvertSidToStringSidW(sid, &mut text) },
            0,
            "ConvertSidToStringSidW failed"
        );
        // SAFETY: `text` is a NUL-terminated UTF-16 string from the conversion above.
        let length = (0..)
            .take_while(|&index| unsafe { *text.add(index) } != 0)
            .count();
        // SAFETY: `text` holds `length` readable units before its terminator.
        let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
        // SAFETY: both allocations came from the calls above and are freed exactly once.
        unsafe {
            LocalFree(text.cast());
            LocalFree(sid.cast());
        }
        value
    }

    fn current_user_sid() -> String {
        let output = std::process::Command::new("whoami")
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .expect("whoami");
        assert!(output.status.success(), "whoami failed: {output:?}");
        let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let sid = line.rsplit(',').next().unwrap_or_default().trim_matches('"');
        assert!(sid.starts_with("S-1-"), "no SID in whoami output: {line}");
        sid.to_string()
    }

    /// The file's DACL as SDDL, read with `GetNamedSecurityInfoW` (no localized account names).
    fn dacl_sddl(path: &Path) -> String {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1,
            SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

        let wide: Vec<u16> = s(path).encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; only the descriptor out-pointer is requested.
        let status = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0, "GetNamedSecurityInfoW failed");
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `descriptor` came from GetNamedSecurityInfoW; `text` receives a LocalAlloc string.
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(
            ok, 0,
            "ConvertSecurityDescriptorToStringSecurityDescriptorW failed"
        );
        // SAFETY: `text` is a NUL-terminated UTF-16 string from the conversion above.
        let length = (0..)
            .take_while(|&index| unsafe { *text.add(index) } != 0)
            .count();
        // SAFETY: `text` holds `length` readable units before its terminator.
        let sddl = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
        // SAFETY: both allocations came from the calls above and are freed exactly once.
        unsafe {
            LocalFree(text.cast());
            LocalFree(descriptor.cast());
        }
        sddl
    }
}
