/**
 * Studio schema for the documents sync.ts writes. Add both to the `schema.types`
 * array of the Studio config so they show up (read-only) under /admin.
 * Not used by the sync script itself.
 */
import { defineField, defineType } from 'sanity'

const str = (name: string) => defineField({ name, type: 'string', readOnly: true })
const num = (name: string) => defineField({ name, type: 'number', readOnly: true })
const date = (name: string) => defineField({ name, type: 'datetime', readOnly: true })

export const womMember = defineType({
  name: 'womMember',
  title: 'WOM member',
  type: 'document',
  fields: [
    num('playerId'),
    num('groupId'),
    str('username'),
    str('displayName'),
    str('role'),
    num('roleOrder'),
    str('accountType'),
    str('build'),
    str('status'),
    str('country'),
    num('exp'),
    num('ehp'),
    num('ehb'),
    date('joinedAt'),
    date('registeredAt'),
    date('womUpdatedAt'),
    date('lastChangedAt'),
  ],
  orderings: [{ name: 'role', title: 'Role', by: [{ field: 'roleOrder', direction: 'asc' }] }],
  preview: { select: { title: 'displayName', subtitle: 'role' } },
})

export const womGroup = defineType({
  name: 'womGroup',
  title: 'WOM group',
  type: 'document',
  fields: [
    num('groupId'),
    str('name'),
    str('clanChat'),
    str('description'),
    num('homeworld'),
    num('score'),
    defineField({ name: 'verified', type: 'boolean', readOnly: true }),
    num('memberCount'),
    defineField({ name: 'profileImage', type: 'url', readOnly: true }),
    defineField({ name: 'bannerImage', type: 'url', readOnly: true }),
    date('womUpdatedAt'),
    date('syncedAt'),
  ],
  preview: { select: { title: 'name', subtitle: 'syncedAt' } },
})
