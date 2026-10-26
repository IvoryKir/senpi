//! First publication of the public socket secret on Windows (#4199 design 4.3 and 4.5): a private
//! same-directory staging file created with `CREATE_NEW` and an explicit protected DACL, written in
//! full and flushed, then renamed onto the final name with `ReplaceIfExists = FALSE`. A destination
//! collision loses to the winner; every other failure keeps its own cause and never falls back to a
//! copy, truncate or direct final-path write.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishOutcome {
    Published,
    /// The final name already existed; the caller reads and validates the winner.
    Collision,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublishError {
    UnsupportedPlatform,
    /// `step` names the failed Windows call; `code` is its `GetLastError` value.
    Os {
        step: &'static str,
        code: u32,
    },
}

#[cfg(not(windows))]
pub fn publish_no_replace(
    _staging: &str,
    _final_path: &str,
    _bytes: &[u8],
) -> Result<PublishOutcome, PublishError> {
    Err(PublishError::UnsupportedPlatform)
}

#[cfg(windows)]
pub use windows_publish::publish_no_replace;

#[cfg(windows)]
mod windows_publish {
    use super::{PublishError, PublishOutcome};
    use crate::owner_dacl::OwnerOnlyDescriptor;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileDispositionInfo, FileRenameInfo, FlushFileBuffers, SetFileInformationByHandle,
        WriteFile, CREATE_NEW, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_DISPOSITION_INFO, FILE_RENAME_INFO,
        FILE_SHARE_DELETE, FILE_SHARE_READ, OPEN_EXISTING, SYNCHRONIZE,
    };

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful CreateFileW and is closed exactly once here.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn wide(path: &str) -> Vec<u16> {
        path.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error(step: &'static str) -> PublishError {
        // SAFETY: reads this thread's last-error value, set by the failed call just before.
        PublishError::Os {
            step,
            code: unsafe { GetLastError() },
        }
    }

    fn open(
        path: &[u16],
        access: u32,
        share: u32,
        disposition: u32,
        sa: *const SECURITY_ATTRIBUTES,
    ) -> Option<OwnedHandle> {
        // SAFETY: `path` is NUL-terminated and outlives the call; `sa` is null or a valid SECURITY_ATTRIBUTES.
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                access,
                share,
                sa,
                disposition,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        (raw != INVALID_HANDLE_VALUE).then_some(OwnedHandle(raw))
    }

    pub fn publish_no_replace(
        staging: &str,
        final_path: &str,
        bytes: &[u8],
    ) -> Result<PublishOutcome, PublishError> {
        let descriptor = OwnerOnlyDescriptor::for_current_user()
            .map_err(|code| PublishError::Os { step: "dacl", code })?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.as_ptr(),
            bInheritHandle: 0,
        };
        let staging_wide = wide(staging);
        {
            let writer = open(&staging_wide, GENERIC_WRITE, 0, CREATE_NEW, &attributes)
                .ok_or_else(|| last_error("create_staging"))?;
            let written = write_all(&writer, bytes).and_then(|()| {
                // SAFETY: `writer` is a live handle opened for writing.
                (unsafe { FlushFileBuffers(writer.0) } != 0)
                    .then_some(())
                    .ok_or_else(|| last_error("flush"))
            });
            if let Err(error) = written {
                drop(writer);
                remove_staging(&staging_wide);
                return Err(error);
            }
        }
        let mover = open(
            &staging_wide,
            DELETE | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            std::ptr::null(),
        )
        .ok_or_else(|| last_error("reopen_staging"))?;
        let outcome = rename_no_replace(&mover, final_path);
        if !matches!(outcome, Ok(PublishOutcome::Published)) {
            mark_for_deletion(&mover);
        }
        outcome
    }

    fn write_all(handle: &OwnedHandle, bytes: &[u8]) -> Result<(), PublishError> {
        let mut offset = 0;
        while offset < bytes.len() {
            let mut written = 0u32;
            let remaining = &bytes[offset..];
            // SAFETY: the buffer pointer and length describe `remaining`; `written` is a writable u32.
            let ok = unsafe {
                WriteFile(
                    handle.0,
                    remaining.as_ptr(),
                    remaining.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(last_error("write"));
            }
            if written == 0 {
                return Err(PublishError::Os {
                    step: "write_zero",
                    code: 0,
                });
            }
            offset += written as usize;
        }
        Ok(())
    }

    /// `FILE_RENAME_INFO` is variable-length: the destination name follows the fixed header.
    fn rename_no_replace(handle: &OwnedHandle, final_path: &str) -> Result<PublishOutcome, PublishError> {
        let name: Vec<u16> = final_path.encode_utf16().collect();
        let header = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let size = header + (name.len() + 1) * 2;
        let mut buffer = vec![0u64; size.div_ceil(8)];
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: `buffer` is 8-byte aligned, at least `size` bytes, and every write stays inside it.
        // The zeroed header is the no-replace contract: ReplaceIfExists = FALSE, RootDirectory = null.
        unsafe {
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
                name.len(),
            );
        }
        // SAFETY: the pointer and byte length describe the FILE_RENAME_INFO built above.
        if unsafe { SetFileInformationByHandle(handle.0, FileRenameInfo, info.cast(), size as u32) } != 0 {
            return Ok(PublishOutcome::Published);
        }
        // SAFETY: reads this thread's last-error value, set by the failed rename above.
        match unsafe { GetLastError() } {
            ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => Ok(PublishOutcome::Collision),
            code => Err(PublishError::Os { step: "rename", code }),
        }
    }

    /// Deletes this exact staging object through its own handle, never by path.
    fn mark_for_deletion(handle: &OwnedHandle) {
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: `info` is a valid FILE_DISPOSITION_INFO and its exact size is passed.
        unsafe {
            SetFileInformationByHandle(
                handle.0,
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
    }

    fn remove_staging(staging: &[u16]) {
        if let Some(handle) = open(
            staging,
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            std::ptr::null(),
        ) {
            mark_for_deletion(&handle);
        }
    }
}
