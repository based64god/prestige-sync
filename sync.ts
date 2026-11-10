/**
 * Sync a Wise Old Man group into Sanity.
 *
 * Reads the WOM group id from the Sanity `siteSettings` document, fetches the
 * group from wiseoldman.net, and mirrors it into the dataset as:
 *   - one `womGroup` document   (_id: womGroup-<groupId>)
 *   - one `womMember` document per member (_id: womMember-<playerId>)
 * Members who left the group are deleted. Only documents whose content
 * actually changed are written, so repeat runs are cheap.
 *
 * Usage:
 *   node --env-file-if-exists=.env sync.ts [--dry-run] [--force]
 *
 * Auth (first match wins):
 *   1. SANITY_API_TOKEN  - API token with Editor rights (sanity.io/manage)
 *   2. SANITY_AUTH_TOKEN - same variable name the Sanity CLI honours
 *   3. Studio login      - the session saved by `npx sanity login`
 *                          (~/.config/sanity/config.json)
 *
 * Exit codes: 0 ok, 1 failure, 2 refused by the safety check.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createClient } from '@sanity/client'
import { WOMClient } from '@wise-old-man/utils'

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const FORCE = args.has('--force')

const env = process.env
const PROJECT_ID = env.SANITY_PROJECT_ID || 'k00wzpm0'
const DATASET = env.SANITY_DATASET || 'production'
/** Refuse to delete more than this share of existing members without --force. */
const MAX_DELETE_RATIO = 0.25

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`)

type Doc = { _id: string; _type: string; [key: string]: unknown }

async function resolveToken(): Promise<{ token?: string; source: string }> {
  if (env.SANITY_API_TOKEN) return { token: env.SANITY_API_TOKEN, source: 'SANITY_API_TOKEN' }
  if (env.SANITY_AUTH_TOKEN) return { token: env.SANITY_AUTH_TOKEN, source: 'SANITY_AUTH_TOKEN' }
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  try {
    const cfg = JSON.parse(await readFile(join(configDir, 'sanity', 'config.json'), 'utf8'))
    if (typeof cfg.authToken === 'string' && cfg.authToken) {
      return { token: cfg.authToken, source: 'studio login (sanity CLI session)' }
    }
  } catch {
    // no CLI session on this machine
  }
  return { source: 'none' }
}

/** Drop null/undefined so documents compare equal to what Sanity stores. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as T
}

/** Strip Sanity-managed fields (_rev, _updatedAt, ...) before comparing. */
function content(doc: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(doc).filter(([k]) => !k.startsWith('_') || k === '_id' || k === '_type'),
  )
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined)

async function main() {
  const { token, source } = await resolveToken()
  if (!token && !DRY_RUN) {
    throw new Error(
      'No Sanity credentials. Set SANITY_API_TOKEN, or run `npx sanity login` once on this machine.',
    )
  }
  log(`sanity ${PROJECT_ID}/${DATASET}, auth: ${source}${DRY_RUN ? ', DRY RUN' : ''}`)

  const sanity = createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: '2025-02-19',
    token,
    useCdn: false,
    perspective: 'raw',
  })

  const groupId = Number(
    env.WOM_GROUP_ID ||
      (await sanity.fetch<number | null>(
        `*[_type == "siteSettings" && !(_id in path("drafts.**")) && defined(womGroupId)][0].womGroupId`,
      )),
  )
  if (!Number.isInteger(groupId) || groupId <= 0) {
    throw new Error('No WOM group id: siteSettings.womGroupId is empty and WOM_GROUP_ID is not set.')
  }

  const wom = new WOMClient({
    apiKey: env.WOM_API_KEY || undefined,
    userAgent: env.WOM_USER_AGENT || 'wom-sanity-sync',
  })
  const group = await wom.groups.getGroupDetails(groupId)
  log(`wom group ${group.id} "${group.name}": ${group.memberships.length} members`)

  const roleOrder = new Map((group.roleOrders ?? []).map((r) => [r.role as string, r.index]))

  const desired = new Map<string, Doc>()
  for (const m of group.memberships) {
    const p = m.player
    const doc = compact({
      _id: `womMember-${p.id}`,
      _type: 'womMember',
      playerId: p.id,
      groupId: group.id,
      username: p.username,
      displayName: p.displayName,
      role: m.role as string,
      roleOrder: roleOrder.get(m.role),
      accountType: p.type as string,
      build: p.build as string,
      status: p.status as string,
      country: p.country as string | null,
      exp: p.exp,
      ehp: p.ehp,
      ehb: p.ehb,
      joinedAt: iso(m.createdAt),
      registeredAt: iso(p.registeredAt),
      womUpdatedAt: iso(p.updatedAt),
      lastChangedAt: iso(p.lastChangedAt),
    })
    desired.set(doc._id, doc)
  }

  const groupDocId = `womGroup-${group.id}`
  const groupDoc: Doc = compact({
    _id: groupDocId,
    _type: 'womGroup',
    groupId: group.id,
    name: group.name,
    clanChat: group.clanChat,
    description: group.description,
    homeworld: group.homeworld,
    score: group.score,
    verified: group.verified,
    memberCount: group.memberCount,
    profileImage: group.profileImage,
    bannerImage: group.bannerImage,
    womUpdatedAt: iso(group.updatedAt),
  })

  const existing = await sanity.fetch<Doc[]>(
    `*[_id == $groupDocId || (_type == "womMember" && groupId == $groupId)]`,
    { groupDocId, groupId: group.id },
  )
  const existingById = new Map(existing.map((d) => [d._id, d]))
  const existingMembers = existing.filter((d) => d._type === 'womMember')

  const upserts = [...desired.values()].filter((doc) => {
    const current = existingById.get(doc._id)
    return !current || !isDeepStrictEqual(content(current), doc)
  })
  const deletes = existingMembers.filter((d) => !desired.has(d._id)).map((d) => d._id)

  // Safety: an empty or truncated WOM response must not wipe the roster.
  if (!FORCE && existingMembers.length > 0) {
    if (desired.size === 0 || deletes.length > existingMembers.length * MAX_DELETE_RATIO) {
      log(
        `REFUSING: would delete ${deletes.length} of ${existingMembers.length} members. ` +
          `Re-run with --force if this is expected.`,
      )
      process.exitCode = 2
      return
    }
  }

  const created = upserts.filter((d) => !existingById.has(d._id)).length
  const membersChanged = upserts.length > 0 || deletes.length > 0
  const currentGroup = existingById.get(groupDocId)
  const groupChanged =
    !currentGroup ||
    !isDeepStrictEqual({ ...content(currentGroup), syncedAt: undefined }, { ...groupDoc, syncedAt: undefined })

  log(
    `plan: ${created} new, ${upserts.length - created} updated, ${deletes.length} removed, ` +
      `${desired.size - upserts.length} unchanged, group ${groupChanged ? 'changed' : 'unchanged'}`,
  )

  if (DRY_RUN) {
    for (const d of upserts.slice(0, 10)) log(`  upsert ${d._id} ${d.displayName}`)
    if (upserts.length > 10) log(`  ... and ${upserts.length - 10} more`)
    for (const id of deletes) log(`  delete ${id} ${existingById.get(id)?.displayName ?? ''}`)
    return
  }
  if (!membersChanged && !groupChanged) {
    log('nothing to do')
    return
  }

  const tx = sanity.transaction()
  tx.createOrReplace({ ...groupDoc, syncedAt: new Date().toISOString() })
  for (const doc of upserts) tx.createOrReplace(doc)
  for (const id of deletes) tx.delete(id)
  const res = await tx.commit({ visibility: 'async' })
  log(`committed transaction ${res.transactionId}`)
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} ERROR ${err?.stack || err}`)
  process.exitCode = 1
})
