/**
 * BackendProtocol — pluggable storage abstraction for file operations.
 *
 * BackendProtocol — pluggable storage abstraction that provides a uniform
 * interface for file operations across different storage backends:
 * - StateBackend: In-memory (ephemeral, for dev/testing)
 * - FilesystemBackend: Real filesystem access
 * - Future: S3, database, remote sandbox, etc.
 *
 * All paths use POSIX conventions (forward slashes) and must be absolute
 * (start with "/"). Backends handle platform-specific conversions.
 */

// ─── Result Types ────────────────────────────────────────────────────────────

export type FileOperationError =
  | "file_not_found"
  | "permission_denied"
  | "is_directory"
  | "invalid_path"
  | "already_exists"
  | "parent_not_found";

export interface FileInfo {
  /** Absolute path to the file or directory */
  path: string;
  /** Whether this entry is a directory */
  isDir: boolean;
  /** File size in bytes (0 for directories) */
  size: number;
  /** ISO timestamp of last modification, if available */
  modifiedAt?: string;
}

export interface ReadResult {
  /** File content as a UTF-8 string, null on failure */
  content: string | null;
  /** Error message on failure, null on success */
  error: FileOperationError | null;
}

export interface WriteResult {
  /** Whether the write succeeded */
  success: boolean;
  /** Absolute path of the written file */
  path: string | null;
  /** Error code on failure */
  error: FileOperationError | null;
}

export interface EditResult {
  /** Whether the edit succeeded */
  success: boolean;
  /** Number of replacements made */
  occurrences: number;
  /** Error code on failure */
  error: FileOperationError | null;
}

export interface ListResult {
  /** List of file info entries, null on failure */
  entries: FileInfo[] | null;
  /** Error code on failure */
  error: FileOperationError | null;
}

export interface GlobResult {
  /** List of matching file info entries, null on failure */
  matches: FileInfo[] | null;
  /** Error code on failure */
  error: FileOperationError | null;
}

export interface GrepMatch {
  /** Path to the file containing the match */
  path: string;
  /** Line number (1-based) */
  line: number;
  /** The matching line text */
  text: string;
}

export interface GrepResult {
  /** List of matches, null on failure */
  matches: GrepMatch[] | null;
  /** Error code on failure */
  error: FileOperationError | null;
}

// ─── Backend Protocol ────────────────────────────────────────────────────────

/**
 * Abstract base for all storage backends.
 *
 * Implementations must provide all methods. Methods that aren't supported
 * should return appropriate error results rather than throwing.
 *
 * ## Path conventions
 *
 * - All paths are absolute POSIX paths (start with "/")
 * - No trailing slashes on directory paths
 * - Backends normalize paths internally
 *
 * ## Error handling
 *
 * - Methods return result objects with error fields instead of throwing
 * - This allows partial success in batch operations
 * - Errors are standardized via FileOperationError for LLM consumption
 */
export interface BackendProtocol {
  /**
   * Read file content as a UTF-8 string.
   *
   * @param path - Absolute path to the file
   * @param options - Optional: offset (line number, 0-based), limit (max lines)
   */
  read(path: string, options?: { offset?: number; limit?: number }): Promise<ReadResult>;

  /**
   * Write content to a file. Creates parent directories if needed.
   * If the file already exists, overwrites it.
   *
   * @param path - Absolute path for the file
   * @param content - UTF-8 string content to write
   */
  write(path: string, content: string): Promise<WriteResult>;

  /**
   * Perform exact string replacement in a file.
   *
   * @param path - Absolute path to the file
   * @param oldString - Exact string to find
   * @param newString - String to replace with
   * @param replaceAll - If true, replace all occurrences; if false, oldString must be unique
   */
  edit(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult>;

  /**
   * List entries in a directory.
   *
   * @param path - Absolute path to the directory
   */
  ls(path: string): Promise<ListResult>;

  /**
   * Find files matching a glob pattern.
   *
   * @param pattern - Glob pattern (e.g., "**\/*.ts")
   * @param basePath - Base directory to search from (default: "/")
   */
  glob(pattern: string, basePath?: string): Promise<GlobResult>;

  /**
   * Search for a text pattern in files.
   *
   * @param pattern - Literal string to search for
   * @param options - Optional: path (directory to search), fileGlob (filter files)
   */
  grep(pattern: string, options?: { path?: string; fileGlob?: string }): Promise<GrepResult>;

  /**
   * Check if a path exists and whether it's a file or directory.
   */
  exists(path: string): Promise<{ exists: boolean; isDir: boolean }>;

  /**
   * Delete a file or directory.
   */
  delete(path: string): Promise<{ success: boolean; error: FileOperationError | null }>;
}

/**
 * Factory function type for creating backends.
 * Allows lazy initialization with runtime context.
 */
export type BackendFactory = () => BackendProtocol;
