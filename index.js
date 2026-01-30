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
import { config } from './config.js'

const ASSOCIATIONS_BATCH_SIZE = 1000 // v4 batch read limit
const DEALS_BATCH_SIZE = 100 // HubSpot batch read limit
const CONTACTS_BATCH_UPDATE_SIZE = 100 // HubSpot batch update limit

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
 * Set analysis_completed_date to today (ms since epoch) for the given contact IDs.
 * Uses batch update; chunks by CONTACTS_BATCH_UPDATE_SIZE.
 */
async function setAnalysisCompletedDate(client, contactIds) {
  const propName = config.analysisCompletedDateProperty
  if (!propName) return
  const todayMs = String(Date.now())
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
