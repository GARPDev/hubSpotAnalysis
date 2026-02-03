/**
 * HubSpot Contact Analysis Script
 *
 * 1. Connects to HubSpot
 * 2. Queries a subset of contacts (filter + properties from config)
 * 3. For each contact, fetches associated deals and activities (calls, emails, meetings, notes, tasks)
 * 4. Sets analysis_completed_date to today for each processed contact
 * 5. Outputs counts to console
 */

import { Client } from '@hubspot/api-client'
import fs from 'fs/promises'
import path from 'path'
import { config } from './config.js'

const ASSOCIATIONS_BATCH_SIZE = 1000 // v4 batch read limit
const DEALS_BATCH_SIZE = 100 // HubSpot batch read limit
const CONTACTS_BATCH_UPDATE_SIZE = 100 // HubSpot batch update limit
const FORMS_API_BASE = 'https://api.hubapi.com' // Legacy Forms API
const FORM_SUBMISSIONS_PAGE_SIZE = 50 // Forms v1 max

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch all forms (Forms v2 API). Returns array of { guid, name, ... }.
 */
async function fetchAllForms(accessToken) {
  const url = `${FORMS_API_BASE}/forms/v2/forms`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Forms API ${res.status}: ${text}`)
  }
  return res.json()
}

/**
 * Parse submission timestamp to ms (handles ms number or ISO string).
 * Returns null if unparseable.
 */
function parseSubmittedAt(submittedAt) {
  if (submittedAt == null) return null
  if (typeof submittedAt === 'number' && !Number.isNaN(submittedAt)) return submittedAt
  const t = new Date(submittedAt).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * Fetch submissions for one form (Form Integrations v1). Yields submission objects.
 * Each submission: { conversionId, submittedAt, values: [{ name, value }], pageUrl }.
 * Stops after maxSubmissions yielded (newest first). maxSubmissions 0 = no limit.
 * If cutoffMs is set, stops when a submission is older than that (submissions are newest-first).
 */
async function* fetchFormSubmissions(accessToken, formGuid, formName, maxSubmissions = 0, cutoffMs = 0) {
  let after = undefined
  let yielded = 0
  while (true) {
    const url = new URL(`${FORMS_API_BASE}/form-integrations/v1/submissions/forms/${formGuid}`)
    url.searchParams.set('limit', String(FORM_SUBMISSIONS_PAGE_SIZE))
    if (after != null) url.searchParams.set('after', String(after))

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Form submissions API ${res.status}: ${text}`)
    }
    const data = await res.json()
    const results = data.results || []
    if (results.length === 0) break

    for (const sub of results) {
      if (cutoffMs > 0) {
        const submittedMs = parseSubmittedAt(sub.submittedAt ?? sub.submitted_at)
        if (submittedMs != null && submittedMs < cutoffMs) return
      }
      yield { ...sub, formGuid, formName }
      yielded++
      if (maxSubmissions > 0 && yielded >= maxSubmissions) return
    }
    after = data.offset ?? data.paging?.next?.after
    if (after == null) break
    await sleep(config.delayBetweenBatchesMs)
  }
}

/**
 * Extract email from submission values (array of { name, value }).
 * HubSpot often uses "email" or "e_mail" as the field name.
 */
function getEmailFromSubmissionValues(values) {
  if (!Array.isArray(values)) return null
  const byName = {}
  for (const v of values) {
    if (v && v.name != null) byName[String(v.name).toLowerCase()] = v.value
  }
  return byName.email ?? byName.e_mail ?? null
}

/**
 * Load form submissions cache from file. Returns { byEmail: Map, fetchedAt } or null.
 */
async function loadFormSubmissionsCache(cachePath) {
  try {
    const json = await fs.readFile(cachePath, 'utf-8')
    const data = JSON.parse(json)
    const byEmail = new Map()
    if (data.byEmail && typeof data.byEmail === 'object') {
      for (const [email, entries] of Object.entries(data.byEmail)) {
        if (Array.isArray(entries)) byEmail.set(email, [...entries])
      }
    }
    return { byEmail, fetchedAt: data.fetchedAt ?? 0 }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Save form submissions cache to file. Ensures directory exists.
 */
async function saveFormSubmissionsCache(cachePath, byEmail) {
  const dir = path.dirname(cachePath)
  await fs.mkdir(dir, { recursive: true })
  const data = {
    fetchedAt: Date.now(),
    byEmail: Object.fromEntries(byEmail),
  }
  await fs.writeFile(cachePath, JSON.stringify(data, null, 0), 'utf-8')
}

/**
 * Merge fresh submissions (from API) into cached byEmail. Dedupes by formGuid+conversionId per email.
 */
function mergeFormSubmissionsIntoCache(cachedByEmail, freshByEmail) {
  for (const [email, entries] of freshByEmail) {
    if (!cachedByEmail.has(email)) cachedByEmail.set(email, [])
    const list = cachedByEmail.get(email)
    for (const entry of entries) {
      const key = `${entry.formGuid ?? ''}:${entry.conversionId ?? ''}`
      const idx = list.findIndex(
        (e) => `${e.formGuid ?? ''}:${e.conversionId ?? ''}` === key
      )
      if (idx >= 0) list[idx] = entry
      else list.push(entry)
    }
  }
}

/**
 * Fetch only the newest page per form (incremental). Returns Map<email, entries[]>.
 */
async function fetchNewestFormSubmissionsOnly(accessToken, forms, cutoffMs) {
  const byEmail = new Map()
  const maxPerForm = FORM_SUBMISSIONS_PAGE_SIZE // one page = 50 newest
  for (const form of forms) {
    const formMap = await collectFormSubmissionsForForm(
      accessToken,
      form,
      maxPerForm,
      cutoffMs
    )
    for (const [email, entries] of formMap) {
      if (!byEmail.has(email)) byEmail.set(email, [])
      byEmail.get(email).push(...entries)
    }
    await sleep(config.delayBetweenBatchesMs)
  }
  return byEmail
}

/**
 * Collect form submissions for one form into a Map<email, entries[]>.
 */
async function collectFormSubmissionsForForm(accessToken, form, maxPerForm, cutoffMs = 0) {
  const formGuid = form.guid ?? form.formId ?? form.id
  const formName = form.name ?? formGuid ?? '(unnamed form)'
  const byEmail = new Map()
  if (!formGuid) return byEmail

  for await (const sub of fetchFormSubmissions(accessToken, formGuid, formName, maxPerForm, cutoffMs)) {
    const email = getEmailFromSubmissionValues(sub.values)
    if (!email || typeof email !== 'string') continue
    const key = String(email).trim().toLowerCase()
    if (!key) continue
    const entry = {
      formName,
      formGuid,
      submittedAt: sub.submittedAt ?? sub.submitted_at ?? null,
      pageUrl: sub.pageUrl ?? sub.page_url ?? null,
      conversionId: sub.conversionId ?? sub.conversion_id ?? null,
      values: sub.values ?? [],
    }
    if (!byEmail.has(key)) byEmail.set(key, [])
    byEmail.get(key).push(entry)
  }
  return byEmail
}

/**
 * Build Map<emailLowercase, submissionDetails[]> from forms and their submissions.
 * Uses cache when configured: load cache, fetch newest page per form from API, merge, save.
 * When no cache: full fetch with config limits, then save to cache if path set.
 */
async function buildFormSubmissionsByEmail(accessToken) {
  const cachePath = config.formSubmissionsCachePath || null
  const maxPerForm = config.formSubmissionsMaxPerForm ?? 0
  const maxForms = config.formSubmissionsMaxForms ?? 0
  const maxAgeMonths = config.formSubmissionsMaxAgeMonths ?? 0
  const concurrency = Math.max(1, config.formSubmissionsConcurrency ?? 1)

  const cutoffMs =
    maxAgeMonths > 0
      ? Date.now() - maxAgeMonths * 30 * 24 * 60 * 60 * 1000
      : 0

  let forms = await fetchAllForms(accessToken)
  await sleep(config.delayBetweenBatchesMs)
  if (maxForms > 0) forms = forms.slice(0, maxForms)

  // Helper: run full fetch into byEmail (with limits)
  const runFullFetch = async (intoByEmail) => {
    if (concurrency <= 1) {
      for (const form of forms) {
        const formMap = await collectFormSubmissionsForForm(
          accessToken,
          form,
          maxPerForm,
          cutoffMs
        )
        for (const [email, entries] of formMap) {
          if (!intoByEmail.has(email)) intoByEmail.set(email, [])
          intoByEmail.get(email).push(...entries)
        }
        await sleep(config.delayBetweenBatchesMs)
      }
    } else {
      for (let i = 0; i < forms.length; i += concurrency) {
        const chunk = forms.slice(i, i + concurrency)
        const maps = await Promise.all(
          chunk.map((form) =>
            collectFormSubmissionsForForm(accessToken, form, maxPerForm, cutoffMs)
          )
        )
        for (const formMap of maps) {
          for (const [email, entries] of formMap) {
            if (!intoByEmail.has(email)) intoByEmail.set(email, [])
            intoByEmail.get(email).push(...entries)
          }
        }
        await sleep(config.delayBetweenBatchesMs)
      }
    }
  }

  // Use cache: load, then always fetch newest page per form and merge; or full fetch if no cache
  if (cachePath) {
    const cached = await loadFormSubmissionsCache(cachePath)
    if (cached) {
      const fresh = await fetchNewestFormSubmissionsOnly(accessToken, forms, cutoffMs)
      mergeFormSubmissionsIntoCache(cached.byEmail, fresh)
      await saveFormSubmissionsCache(cachePath, cached.byEmail)
      console.log(
        'Form submissions: loaded cache, fetched newest page per form from API, merged and saved.'
      )
      return cached.byEmail
    }
    const byEmail = new Map()
    await runFullFetch(byEmail)
    await saveFormSubmissionsCache(cachePath, byEmail)
    console.log('Form submissions: no cache, did full fetch, saved cache.')
    return byEmail
  }

  // No cache path: full fetch only
  const byEmail = new Map()
  await runFullFetch(byEmail)
  return byEmail
}

/**
 * Search contacts with pagination; yields pages of contact objects.
 */
async function* searchContacts(client) {
  const { contactSearch } = config
  let after = undefined
  let totalFetched = 0

  while (true) {
    const body = {
      filterGroups: contactSearch.filterGroups,
      sorts: contactSearch.sorts,
      properties: contactSearch.properties,
      limit: Math.min(contactSearch.limit, 200),
      after: after ?? 0,
    }

    const response = await client.crm.contacts.searchApi.doSearch(body)
    const results = response.results || []
    if (results.length === 0) break

    totalFetched += results.length
    if (config.contactSearch.maxContacts > 0 && totalFetched > config.contactSearch.maxContacts) {
      const trim = totalFetched - config.contactSearch.maxContacts
      yield results.slice(0, results.length - trim)
      break
    }

    yield results
    const next = response.paging?.next?.after
    if (!next) break
    after = next
    await sleep(config.delayBetweenBatchesMs)
  }
}

/**
 * Call v4 associations batch/read for one object type.
 * Returns Map<contactId, string[]> – list of associated object IDs per contact.
 */
async function getAssociationIds(client, contactIds, toObjectType) {
  const fromObjectType = 'contacts'
  const idList = contactIds.map((id) => ({ id: String(id) }))
  const idMap = new Map(contactIds.map((id) => [id, []]))

  for (let i = 0; i < idList.length; i += ASSOCIATIONS_BATCH_SIZE) {
    const batch = idList.slice(i, i + ASSOCIATIONS_BATCH_SIZE)
    const path = `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/read`
    const res = await client.apiRequest({
      method: 'POST',
      path,
      body: { inputs: batch },
    })
    const data = await res.json()
    const results = data.results || []
    for (const r of results) {
      const fromId = r.from?.id
      const toList = (r.to || []).map((t) => String(t.toObjectId))
      if (fromId) idMap.set(fromId, (idMap.get(fromId) || []).concat(toList))
    }
    await sleep(config.delayBetweenBatchesMs)
  }

  return idMap
}

/**
 * For a list of contact IDs, fetch associated IDs for deals and all activity types.
 * Returns Map<contactId, { deals: string[], calls: string[], ... }>.
 */
async function buildAssociations(client, contactIds, activityTypesToCount) {
  const keys = Object.keys(activityTypesToCount)
  const maps = {}

  for (const key of keys) {
    const toObjectType = activityTypesToCount[key]
    maps[key] = await getAssociationIds(client, contactIds, toObjectType)
  }

  const result = new Map()
  for (const id of contactIds) {
    const associations = {}
    for (const key of keys) {
      associations[key] = maps[key].get(id) || []
    }
    result.set(id, associations)
  }
  return result
}

/**
 * Fetch all deal pipeline stages and build stage ID -> stage name (label) map.
 * Returns Map<stageId, label>.
 */
async function fetchDealStageLabels(client) {
  const stageIdToLabel = new Map()
  const pipelinesRes = await client.crm.pipelines.pipelinesApi.getAll('deals')
  const pipelines = pipelinesRes.results || []
  for (const pipeline of pipelines) {
    const full = await client.crm.pipelines.pipelinesApi.getById('deals', pipeline.id)
    const stages = full.stages || []
    for (const stage of stages) {
      if (stage.id != null) stageIdToLabel.set(String(stage.id), stage.label ?? String(stage.id))
    }
    await sleep(config.delayBetweenBatchesMs)
  }
  return stageIdToLabel
}

/**
 * Batch fetch deal name, amount, and stage for a list of deal IDs.
 * Returns Map<dealId, { dealname, amount, dealstage }>.
 */
async function fetchDealDetails(client, dealIds) {
  const uniqueIds = [...new Set(dealIds)]
  if (uniqueIds.length === 0) return new Map()

  const dealProps = ['dealname', 'amount', 'dealstage']
  const map = new Map()

  for (let i = 0; i < uniqueIds.length; i += DEALS_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + DEALS_BATCH_SIZE).map((id) => ({ id }))
    const response = await client.crm.deals.batchApi.read({
      inputs: batch,
      properties: dealProps,
    })
    const results = response.results || []
    for (const deal of results) {
      const id = String(deal.id)
      const props = deal.properties || {}
      map.set(id, {
        dealname: props.dealname ?? '(no name)',
        amount: props.amount ?? '(no amount)',
        dealstage: props.dealstage ?? '(no stage)',
      })
    }
    await sleep(config.delayBetweenBatchesMs)
  }
  return map
}

/**
 * Set analysis_completed_date to today at midnight UTC (ms since epoch) for the given contact IDs.
 * HubSpot date properties require midnight, not a timestamp with time.
 */
async function setAnalysisCompletedDate(client, contactIds) {
  const propName = config.analysisCompletedDateProperty
  if (!propName) return
  const now = new Date()
  const todayMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const todayMs = String(todayMidnightUtc)
  for (let i = 0; i < contactIds.length; i += CONTACTS_BATCH_UPDATE_SIZE) {
    const batch = contactIds.slice(i, i + CONTACTS_BATCH_UPDATE_SIZE)
    const inputs = batch.map((id) => ({
      id: String(id),
      properties: { [propName]: todayMs },
    }))
    await client.crm.contacts.batchApi.update({ inputs })
    await sleep(config.delayBetweenBatchesMs)
  }
}

async function main() {
  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    console.error('Missing HUBSPOT_ACCESS_TOKEN. Set it in your environment (e.g. export HUBSPOT_ACCESS_TOKEN=your-token).')
    process.exit(1)
  }

  const client = new Client({ accessToken })
  const { activityTypesToCount } = config
  const counterKeys = Object.keys(activityTypesToCount)
  let totalProcessed = 0

  const stageIdToLabel = await fetchDealStageLabels(client)

  console.log('Starting HubSpot contact analysis...')
  console.log('Contact search:', JSON.stringify(config.contactSearch.filterGroups, null, 2))
  console.log('Counters:', counterKeys.join(', '))
  let formSubmissionsByEmail = new Map()
  if (config.fetchFormSubmissions) {
    console.log('Fetching form submissions (Forms API)...')
    formSubmissionsByEmail = await buildFormSubmissionsByEmail(accessToken)
    console.log(`Form submissions indexed for ${formSubmissionsByEmail.size} email(s).`)
  }
  console.log('')

  for await (const page of searchContacts(client)) {
    const contactIds = page.map((c) => c.id)
    if (contactIds.length === 0) continue

    const associationsByContact = await buildAssociations(client, contactIds, activityTypesToCount)

    const allDealIds = []
    for (const assoc of associationsByContact.values()) {
      allDealIds.push(...(assoc.deals || []))
    }
    const dealDetails = await fetchDealDetails(client, allDealIds)

    for (const contact of page) {
      const associations = associationsByContact.get(contact.id) || {}
      const email = contact.properties?.email ?? '(no email)'
      const name = [contact.properties?.firstname, contact.properties?.lastname].filter(Boolean).join(' ') || '(no name)'

      console.log(`  Contact: ${contact.id}  ${email}  ${name}`)
      console.log(`    Counts: ${counterKeys.map((k) => `${k}: ${(associations[k] || []).length}`).join(', ')}`)

      // Form submissions (matched by contact email)
      const contactEmailKey = (contact.properties?.email && String(contact.properties.email).trim().toLowerCase()) || ''
      const formSubmissions = contactEmailKey ? (formSubmissionsByEmail.get(contactEmailKey) || []) : []
      if (formSubmissions.length > 0) {
        console.log(`    Form submissions (${formSubmissions.length}):`)
        for (const sub of formSubmissions) {
          const submittedAtStr = sub.submittedAt
            ? (typeof sub.submittedAt === 'number'
              ? new Date(sub.submittedAt).toISOString()
              : String(sub.submittedAt))
            : '(no date)'
          console.log(`      - Form: "${sub.formName}" (guid: ${sub.formGuid})`)
          console.log(`        Submitted: ${submittedAtStr}`)
          if (sub.pageUrl) console.log(`        Page URL: ${sub.pageUrl}`)
          if (sub.conversionId) console.log(`        Conversion ID: ${sub.conversionId}`)
          if (Array.isArray(sub.values) && sub.values.length > 0) {
            const fields = sub.values.map((v) => `${v.name}=${v.value}`).join(', ')
            console.log(`        Fields: ${fields}`)
          }
        }
      }

      // Loop over each deal
      const dealIds = associations.deals || []
      for (const dealId of dealIds) {
        const details = dealDetails.get(dealId) || { dealname: '(unknown)', amount: '(unknown)', dealstage: '(unknown)' }
        const stageName = details.dealstage ? (stageIdToLabel.get(String(details.dealstage)) ?? details.dealstage) : '(no stage)'
        console.log(`      Deal: ${dealId}  "${details.dealname}"  amount: ${details.amount}  stage: ${stageName}`)
      }

      // Loop over each activity (calls, emails, meetings, notes, tasks)
      for (const activityType of counterKeys) {
        if (activityType === 'deals') continue
        const ids = associations[activityType] || []
        for (const activityId of ids) {
          console.log(`      ${activityType}: ${activityId}`)
        }
      }
      console.log('')
    }

    await setAnalysisCompletedDate(client, contactIds)
    totalProcessed += contactIds.length
    console.log(`  --- page done, ${totalProcessed} total so far ---\n`)
  }

  console.log('Done. Total contacts processed:', totalProcessed)
}

main().catch((err) => {
  console.error('Error:', err.message)
  if (err.response) {
    console.error('Status:', err.response.status)
    console.error('Body:', err.body)
  }
  process.exit(1)
})
