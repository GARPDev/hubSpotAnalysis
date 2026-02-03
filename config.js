/**
 * Configuration for the HubSpot contact analysis script.
 * Adjust filters, properties, and custom property names to match your HubSpot account.
 *
 * Required env var (set on your machine, not in a file):
 *   export HUBSPOT_ACCESS_TOKEN=your-token
 * Add that line to ~/.zshrc (or ~/.bashrc) so it's set in every shell, or run it once before npm start.
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
          {
            propertyName: 'analysis_completed_date',
            operator: 'HAS_PROPERTY',
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
    maxContacts: 20,
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

  /**
   * Contact property (internal name) set to today's date when the contact is processed.
   * Create in HubSpot: Settings → Properties → Contact, type Date.
   */
  analysisCompletedDateProperty: 'analysis_completed_date',

  /** Delay in ms between batch API calls to avoid rate limits. */
  delayBetweenBatchesMs: 150,

  /**
   * Fetch form submissions via Forms API and match to contacts by email.
   * Requires Forms API scopes (e.g. forms) on your private app.
   */
  fetchFormSubmissions: true,

  /**
   * Limit form submission fetch to speed up runs.
   * - maxPerForm: max submissions to fetch per form (newest first). 0 = no limit (slow).
   * - maxForms: max forms to fetch submissions for. 0 = all forms.
   * - maxAgeMonths: only include submissions from the last N months. 0 = no date filter.
   * - concurrency: number of forms to fetch in parallel (1 = sequential).
   */
  formSubmissionsMaxPerForm: 500,
  formSubmissionsMaxForms: 0,
  formSubmissionsMaxAgeMonths: 24,
  formSubmissionsConcurrency: 3,

  /**
   * Cache form submissions to a file to speed up repeated runs.
   * - cachePath: file path (e.g. 'cache/form-submissions.json'). Falsy = no cache.
   * - When cache exists: load it, then fetch only the newest page per form from the API and merge.
   * - When no cache: full fetch (with limits), then save to cache.
   */
  formSubmissionsCachePath: 'cache/form-submissions.json',
}

export default config
