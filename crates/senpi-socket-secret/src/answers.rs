//! Revision 8.2 of the #4199 design: which raw answers of the Windows volume queries mean "absent"
//! rather than "failed". Only the exact codes listed here become an answer; every other error stays
//! `QueryFailed`, so the classifier keeps failing closed on anything unexpected. The raw codes travel
//! in [`ProbeCodes`] so a receipt shows what the kernel actually returned.

use crate::classify::{DriverPath, RemoteProtocol};

/// `STATUS_OBJECT_NAME_NOT_FOUND`: the I/O manager found no driver object with the queried name, so
/// that driver is not loaded and cannot be in this volume's I/O path.
pub const STATUS_OBJECT_NAME_NOT_FOUND: i32 = 0xC000_0034_u32.cast_signed();

/// Win32 errors with which a file system that is not a redirector rejects `FileRemoteProtocolInfo`:
/// `ERROR_INVALID_FUNCTION`, `ERROR_NOT_SUPPORTED` and the documented `ERROR_INVALID_PARAMETER`.
pub const REMOTE_PROTOCOL_ABSENT_ERRORS: [u32; 3] = [1, 50, 87];

/// The raw answers one probe received, for receipts and diagnostics. NTSTATUS values are kept as
/// returned; `remote_protocol_error` is `GetLastError()` after a failed query and 0 after success.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProbeCodes {
    pub ntfs_status: i32,
    pub refs_status: i32,
    pub device_status: i32,
    pub remote_protocol_error: u32,
}

/// `NtQueryVolumeInformationFile(FileFsDriverPathInformation)` for one driver name.
pub const fn driver_path_from_query(status: i32, driver_in_path: bool) -> DriverPath {
    if status == STATUS_OBJECT_NAME_NOT_FOUND {
        DriverPath::NotInPath
    } else if status < 0 {
        DriverPath::QueryFailed
    } else if driver_in_path {
        DriverPath::InPath
    } else {
        DriverPath::NotInPath
    }
}

/// `GetFileInformationByHandleEx(FileRemoteProtocolInfo)`: a redirector answers it.
pub fn remote_protocol_from_query(answered: bool, last_error: u32) -> RemoteProtocol {
    if answered {
        RemoteProtocol::Available
    } else if REMOTE_PROTOCOL_ABSENT_ERRORS.contains(&last_error) {
        RemoteProtocol::Unavailable
    } else {
        RemoteProtocol::QueryFailed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classify::{classify, Locality, RemoteDevice, VolumeFacts};

    // Revision 8.2: the exact answers that mean "absent" map to an answer; every other error stays a
    // failure, so the classifier keeps failing closed on anything unexpected.
    #[test]
    fn a_driver_that_is_not_loaded_is_not_in_the_path_and_other_errors_fail() {
        assert_eq!(driver_path_from_query(0, true), DriverPath::InPath);
        assert_eq!(driver_path_from_query(0, false), DriverPath::NotInPath);
        assert_eq!(
            driver_path_from_query(STATUS_OBJECT_NAME_NOT_FOUND, false),
            DriverPath::NotInPath
        );
        assert_eq!(
            driver_path_from_query(STATUS_OBJECT_NAME_NOT_FOUND, true),
            DriverPath::NotInPath
        );
        for unexpected in [
            0xC000_0022_u32,
            0xC000_000D,
            0xC000_0003,
            0xC000_0010,
            0xC000_00BB,
            0xC000_003A,
        ] {
            assert_eq!(
                driver_path_from_query(unexpected.cast_signed(), true),
                DriverPath::QueryFailed,
                "{unexpected:#010x}"
            );
        }
    }

    #[test]
    fn a_file_system_that_rejects_the_remote_protocol_class_is_not_remote_and_other_errors_fail() {
        assert_eq!(remote_protocol_from_query(true, 0), RemoteProtocol::Available);
        assert_eq!(remote_protocol_from_query(true, 87), RemoteProtocol::Available);
        for absent in REMOTE_PROTOCOL_ABSENT_ERRORS {
            assert_eq!(
                remote_protocol_from_query(false, absent),
                RemoteProtocol::Unavailable,
                "{absent}"
            );
        }
        // ERROR_ACCESS_DENIED, ERROR_BAD_LENGTH, ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA,
        // ERROR_BAD_NETPATH, ERROR_NETNAME_DELETED, ERROR_UNEXP_NET_ERR: never "not remote".
        for unexpected in [5_u32, 24, 122, 234, 53, 64, 59, 0] {
            assert_eq!(
                remote_protocol_from_query(false, unexpected),
                RemoteProtocol::QueryFailed,
                "{unexpected}"
            );
        }
    }

    // Receipt 28 in CI run 40253941781: on a fixed NTFS volume the ReFS driver query failed, which
    // made the volume `not_local` although only the NTFS driver is required for it. A ReFS driver that
    // is not loaded must leave a kernel NTFS volume `local`.
    #[test]
    fn a_kernel_ntfs_volume_stays_local_when_the_refs_driver_is_not_loaded() {
        let volume = VolumeFacts {
            reported_file_system: Some("NTFS".to_string()),
            ntfs_driver: driver_path_from_query(0, true),
            refs_driver: driver_path_from_query(STATUS_OBJECT_NAME_NOT_FOUND, false),
            remote_device: RemoteDevice::Clear,
            remote_protocol: remote_protocol_from_query(false, 87),
            codes: ProbeCodes::default(),
        };
        assert_eq!(classify(&volume), Locality::Local);
    }
}
