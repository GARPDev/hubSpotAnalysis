# HubSpot Contact Analysis

Node.js script that connects to your HubSpot instance, queries a subset of contacts, retrieves selected properties, iterates over each contact’s **deals** and **activities** (calls, emails, meetings, notes, tasks), counts them by type, and writes those counts to custom contact properties.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure HubSpot**

   - Create a [Private App](https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview) (or use OAuth).
   - Grant scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.contacts.associations.read`, `crm.objects.deals.read`, and engagement/association read as needed for the activity types you count.
   - Copy the access token.

3. **Environment**

   ```bash
   cp .env.example .env
   # Edit .env and set HUBSPOT_ACCESS_TOKEN=your-token
   ```

4. **Custom properties in HubSpot**

   In **Settings → Properties → Contact**, create **number** properties that the script will update. Default internal names in `config.js` are:

   - `num_deals`
   - `num_calls`
   - `num_emails`
   - `num_meetings`
   - `num_notes`
   - `num_tasks`

   You can change these in `config.js` under `customProperties`.

## Configuration

Edit **`config.js`** to control:

- **Contact subset**: `contactSearch.filterGroups` and `contactSearch.filters` (e.g. by `createdate`, `lifecyclestage`, etc.).
- **Contact properties**: `contactSearch.properties` (which fields to request when searching).
- **Counts**: `activityTypesToCount` (which association types to count: deals, calls, emails, meetings, notes, tasks).
- **Custom properties**: `customProperties` (which contact number property to set for each counter).
- **Limits**: `contactSearch.limit` (page size), `contactSearch.maxContacts` (0 = no limit), and `delayBetweenBatchesMs` (throttling).

## Run

```bash
npm start
# or
node index.js
```

The script will:

1. Search contacts using the filters and properties in `config.js`.
2. For each batch of contacts, call the HubSpot Associations v4 API to get associated deals and activities.
3. Count per contact: deals, calls, emails, meetings, notes, tasks.
4. Batch-update each contact with the configured custom number properties.

## Requirements

- Node.js 18+
- HubSpot account with CRM (Marketing/Sales/Service Hub Free or higher)
- Custom contact properties created in HubSpot for the counters you use
