package session

import "syscall"

// diskFree reports free bytes on the filesystem containing path — GET /health's diskFreeBytes
// (docs/plans/voice-contracts.md §2.5), also usable by an operator/disk-space monitor per R4.
func diskFree(path string) (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}

	return int64(stat.Bavail) * int64(stat.Bsize), nil //nolint:gosec // reasonable range for disk sizes
}
