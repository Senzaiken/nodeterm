/**
 * The app-level unread count (macOS Dock badge, Windows taskbar overlay, tray) and the boot-time
 * cleanup of status entries that belong to no node.
 *
 * The agent-status table is keyed by node id and persisted, and it is NOT pruned when a node goes
 * away by any path other than the few delete funnels that call `remove` (an outside edit or a sync
 * that drops nodes, an in-place reload, …). Counting every `unread` entry in it therefore counted
 * nodes that no longer exist anywhere — measured on one machine: 633 entries, 20 unread, 1 of them
 * a live node; the Dock said 20 while the only tab badge said 1. The count is now taken over the
 * nodes the projects actually hold, the same set the tab badges count from.
 *
 * Pure, so the rules test without a store.
 */

interface StatusLike {
  unread?: boolean
  lastSeen?: { at: number }
}

interface ProjectLike {
  nodes: ReadonlyArray<{ id: string }>
}

/** The unread node ids as one primitive string — the selector shape the tab bar and the canvas
 *  subscribe with, so a working/waiting flip of any agent does not re-render them. */
export function unreadIdsSig(byId: Readonly<Record<string, StatusLike | undefined>>): string {
  let ids = ''
  for (const [id, st] of Object.entries(byId)) if (st?.unread) ids += `${id}|`
  return ids
}

/** Parse `unreadIdsSig` back into a set. */
export function unreadIdSet(sig: string): Set<string> {
  return new Set(sig.split('|').filter(Boolean))
}

/**
 * Unread nodes that exist in a project. Every project counts, CLOSED ones included: a closed
 * project keeps its sessions running and "go to node" reopens it, so its unread finish is still
 * one the user has not seen (the count has always been "across all projects"). What it never
 * counts is an entry whose node is in no project at all.
 */
export function countUnreadInProjects(
  projects: ReadonlyArray<ProjectLike>,
  unread: ReadonlySet<string>
): number {
  if (unread.size === 0) return 0
  const seen = new Set<string>()
  for (const p of projects) for (const n of p.nodes) if (unread.has(n.id)) seen.add(n.id)
  return seen.size
}

/** A status entry whose node is in no project is kept this long after its last hook event before
 *  the boot sweep drops it. The node may come back: an SSH project's offline copy can lag the host
 *  until the next reconcile, and a git checkout can restore an older canvas — dropping its entry at
 *  once would cost it its resume id. */
export const ORPHAN_STATUS_GRACE_MS = 7 * 24 * 60 * 60_000

/**
 * The status ids the boot sweep may drop: their node is in no project, and their last hook event
 * (if any was recorded) is older than the grace window. Returns `[]` — sweep nothing — unless the
 * projects can be trusted to be COMPLETE: an empty list (a fresh, failed or corrupt index load) or
 * any project whose content could not be read (an `unavailable` placeholder carries no nodes)
 * would make every one of its live nodes look orphaned.
 */
export function orphanStatusIds(
  byId: Readonly<Record<string, StatusLike | undefined>>,
  projects: ReadonlyArray<ProjectLike & { unavailable?: boolean }>,
  nowMs: number,
  graceMs: number = ORPHAN_STATUS_GRACE_MS
): string[] {
  if (projects.length === 0 || projects.some((p) => p.unavailable)) return []
  const live = new Set<string>()
  for (const p of projects) for (const n of p.nodes) live.add(n.id)
  const out: string[] = []
  for (const [id, st] of Object.entries(byId)) {
    if (live.has(id)) continue
    const at = st?.lastSeen?.at
    if (typeof at === 'number' && nowMs - at < graceMs) continue
    out.push(id)
  }
  return out
}
