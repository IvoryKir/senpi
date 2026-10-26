//! Native receipts for #4199 first publication (design tests 1, 2 and the "Windows native primitive"
//! and "Permission boundary" rows). Windows only; `ci.yml` `socket-secret-native-windows` runs them and
//! prints `RECEIPT_PUBLISH` lines.

#[cfg(windows)]
mod windows {
    use senpi_socket_secret::{publish_no_replace, PublishOutcome};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("senpi-publish-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
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
        let outcome = publish_no_replace(&s(&dir.join("rpc.sock.secret.stage-a")), &s(&final_path), &bytes);
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
        let outcome = publish_no_replace(
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
        let outcome = publish_no_replace(
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
                    let outcome = publish_no_replace(
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
        let outcome = publish_no_replace(&s(&staging), &s(&dir.join("rpc.sock.secret")), &[5u8; 32]);
        println!("RECEIPT_PUBLISH staging_exists outcome={outcome:?}");
        assert!(outcome.is_err());
        assert!(!dir.join("rpc.sock.secret").exists());
        assert_eq!(std::fs::read(&staging).expect("staging kept"), b"someone else's");
    }

    #[test]
    fn the_published_secret_has_a_protected_owner_only_dacl() {
        let dir = scratch("dacl");
        let final_path = dir.join("rpc.sock.secret");
        assert_eq!(
            publish_no_replace(
                &s(&dir.join("rpc.sock.secret.stage-e")),
                &s(&final_path),
                &[6u8; 32]
            ),
            Ok(PublishOutcome::Published)
        );
        let output = std::process::Command::new("icacls")
            .arg(&final_path)
            .output()
            .expect("icacls");
        let acl = String::from_utf8_lossy(&output.stdout).to_string();
        println!("RECEIPT_PUBLISH dacl {}", acl.replace(['\r', '\n'], " "));
        assert!(!acl.contains("(I)"), "no inherited ACE: {acl}");
        for broad in ["Everyone", "BUILTIN\\Users", "Authenticated Users"] {
            assert!(!acl.contains(broad), "{broad} must not appear: {acl}");
        }
    }
}
