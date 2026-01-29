/**
 * Configuration for the HubSpot contact analysis script.
 * Adjust filters, properties, and custom property names to match your HubSpot account.
 */

export const config = {
  /**
   * Contact search: defines which contacts are processed.
   * @see https://developers.hubspot.com/docs/api/crm/search
   */
  contactSearch: {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'frm_program_start_date',
            operator: 'BETWEEN',
            value: `${new Date('2024-12-01T00:00:00Z').getTime()}`,   // 12/1/2024
            highValue: `${new Date('2025-01-31T23:59:59.999Z').getTime()}`, // 1/31/2025
          },
          {
            propertyName: 'num_conversion_events', // "Number of form submissions" – verify in Settings → Properties if needed
            operator: 'GT',
            value: '0',
          },
        ],
      },
    ],
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
    /** Contact properties to fetch (besides id). Use HubSpot internal names. */
    properties: ['email', 'firstname', 'lastname', 'createdate', 'lifecyclestage'],
    /** Max contacts per search page (max 200). */
    limit: 100,
    /** Max total contacts to process in this run (set to 0 for no limit). */
    maxContacts: 10,
  },

  /**
   * Which association types to count per contact.
   * Keys are used as counter names; values are HubSpot object types for the v4 associations API.
   */
  activityTypesToCount: {
    deals: 'deals',
    calls: 'calls',
    emails: 'emails',
    meetings: 'meetings',
    notes: 'notes',
    tasks: 'tasks',
  },

  /**
   * Custom contact property internal names where each counter will be written.
   * Create these properties in HubSpot (Settings → Properties → Contact) as number type.
   * Use internal names (lowercase, underscores).
   */
  customProperties: {
    deals: 'num_deals',
    calls: 'num_calls',
    emails: 'num_emails',
    meetings: 'num_meetings',
    notes: 'num_notes',
    tasks: 'num_tasks',
  },

  /** Delay in ms between batch API calls to avoid rate limits. */
  delayBetweenBatchesMs: 150,
}

export default config
