/**
 * Filesystem persistence models.
 *
 * One flag per row of the property table in docs/model.md. A property no source
 * states is disabled, which loses bugs rather than inventing them.
 */

export type FilesystemModel = {
  name: string

  /** Every operation persists in program order (data journaling modes). */
  totalOrder: boolean

  /** An append followed by a rename of the same file persists in that order. */
  orderedAppendRename: boolean

  /** fsync on a new file also persists its directory entry. */
  fsyncPersistsDirEntry: boolean

  /** A 4 KiB overwrite is atomic (data journaling or copy-on-write). */
  atomicBlockOverwrite: boolean

  /** Directory operations on different directories may reorder. */
  reordersDirectoryOps: boolean
}

export const ext4Ordered: FilesystemModel = {
  name: 'ext4-ordered',
  totalOrder: false,
  orderedAppendRename: true,
  fsyncPersistsDirEntry: true,
  atomicBlockOverwrite: false,
  reordersDirectoryOps: false,
}

export const ext4Journal: FilesystemModel = {
  name: 'ext4-journal',
  totalOrder: true,
  orderedAppendRename: true,
  fsyncPersistsDirEntry: true,
  atomicBlockOverwrite: true,
  reordersDirectoryOps: false,
}

export const xfs: FilesystemModel = {
  name: 'xfs',
  totalOrder: false,
  orderedAppendRename: false,
  fsyncPersistsDirEntry: false,
  atomicBlockOverwrite: false,
  reordersDirectoryOps: false,
}

export const btrfs: FilesystemModel = {
  name: 'btrfs',
  totalOrder: false,
  orderedAppendRename: false,
  fsyncPersistsDirEntry: false,
  atomicBlockOverwrite: false,
  reordersDirectoryOps: true,
}

export const MODELS = [ext4Ordered, ext4Journal, xfs, btrfs]
