'use strict';

require('dotenv').config();

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const jsforce = require('jsforce');

// ─── Salesforce connection ────────────────────────────────────────────────────

let _conn = null;
let _tokenExpiresAt = 0;

const LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

/**
 * Fetch a new access token from Salesforce using the Connected App.
 *
 * Supports two grant types:
 *  - client_credentials  →  SF_CLIENT_ID + SF_CLIENT_SECRET only
 *  - password            →  SF_CLIENT_ID + SF_CLIENT_SECRET + SF_USERNAME + SF_PASSWORD
 */
async function fetchAccessToken() {
  const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD, SF_SECURITY_TOKEN } = process.env;

  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    throw new Error(
      'Connected App credentials not configured. Set SF_CLIENT_ID and SF_CLIENT_SECRET in your .env file.'
    );
  }

  const params = new URLSearchParams();
  params.set('client_id', SF_CLIENT_ID);
  params.set('client_secret', SF_CLIENT_SECRET);

  if (SF_USERNAME && SF_PASSWORD) {
    // OAuth2 Resource Owner Password Grant (includes Connected App credentials)
    params.set('grant_type', 'password');
    params.set('username', SF_USERNAME);
    params.set('password', SF_PASSWORD + (SF_SECURITY_TOKEN || ''));
  } else {
    // OAuth2 Client Credentials Grant (no user — requires the Connected App to have
    // "Enable Client Credentials Flow" turned on in Salesforce Setup)
    params.set('grant_type', 'client_credentials');
  }

  const tokenUrl = `${LOGIN_URL}/services/oauth2/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(
      `Salesforce OAuth2 error: ${data.error} – ${data.error_description ?? JSON.stringify(data)}`
    );
  }

  // issued_at is epoch milliseconds; tokens are valid for ~2 hours
  _tokenExpiresAt = Date.now() + 110 * 60 * 1000; // refresh 10 min before expiry
  return { accessToken: data.access_token, instanceUrl: data.instance_url };
}

/**
 * Returns an authenticated jsforce Connection, refreshing the token when needed.
 */
async function getConnection() {
  // Option C: pre-supplied access token (takes priority)
  if (process.env.SF_ACCESS_TOKEN && process.env.SF_INSTANCE_URL) {
    if (!_conn) {
      _conn = new jsforce.Connection({
        accessToken: process.env.SF_ACCESS_TOKEN,
        instanceUrl: process.env.SF_INSTANCE_URL,
      });
    }
    return _conn;
  }

  // Connected App OAuth2 (client_credentials or password grant)
  const tokenExpired = !_conn || Date.now() >= _tokenExpiresAt;
  if (tokenExpired) {
    const { accessToken, instanceUrl } = await fetchAccessToken();
    _conn = new jsforce.Connection({ accessToken, instanceUrl });
  }

  return _conn;
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'salesforce',
  version: '1.0.0',
});

// ─── Tool: sf_query ──────────────────────────────────────────────────────────
server.tool(
  'sf_query',
  'Run an arbitrary SOQL query against Salesforce and return the records.',
  {
    soql: z.string().describe('A valid SOQL query string, e.g. "SELECT Id, Name FROM Account LIMIT 5"'),
  },
  async ({ soql }) => {
    const conn = await getConnection();
    const result = await conn.query(soql);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { totalSize: result.totalSize, done: result.done, records: result.records },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── Tool: sf_get_accounts ───────────────────────────────────────────────────
server.tool(
  'sf_get_accounts',
  'Fetch Salesforce Account records with optional filters.',
  {
    limit: z.number().int().min(1).max(200).optional()
      .describe('Max number of records to return (default 10, max 200)'),
    industry: z.string().optional()
      .describe('Filter by Industry field value, e.g. "Technology"'),
    name_like: z.string().optional()
      .describe('Filter by Name using LIKE, e.g. "Acme" matches names containing "Acme"'),
  },
  async ({ limit = 10, industry, name_like }) => {
    const conn = await getConnection();

    const conditions = [];
    if (industry) conditions.push(`Industry = '${industry.replace(/'/g, "\\'")}'`);
    if (name_like) conditions.push(`Name LIKE '%${name_like.replace(/'/g, "\\'")}%'`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const soql = `SELECT Id, Name, Industry, Type, AnnualRevenue, NumberOfEmployees,
                         BillingCity, BillingCountry, Phone, Website, Description,
                         CreatedDate, LastModifiedDate
                  FROM Account
                  ${where}
                  ORDER BY LastModifiedDate DESC
                  LIMIT ${limit}`;

    const result = await conn.query(soql);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ totalSize: result.totalSize, records: result.records }, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: sf_get_contacts ───────────────────────────────────────────────────
server.tool(
  'sf_get_contacts',
  'Fetch Salesforce Contact records with optional filters.',
  {
    limit: z.number().int().min(1).max(200).optional()
      .describe('Max number of records to return (default 10)'),
    account_id: z.string().optional()
      .describe('Filter contacts belonging to a specific Account ID'),
    email_like: z.string().optional()
      .describe('Filter by Email using LIKE pattern'),
  },
  async ({ limit = 10, account_id, email_like }) => {
    const conn = await getConnection();

    const conditions = [];
    if (account_id) conditions.push(`AccountId = '${account_id}'`);
    if (email_like) conditions.push(`Email LIKE '%${email_like.replace(/'/g, "\\'")}%'`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const soql = `SELECT Id, FirstName, LastName, Email, Phone, Title,
                         AccountId, Account.Name, Department, LeadSource,
                         CreatedDate, LastModifiedDate
                  FROM Contact
                  ${where}
                  ORDER BY LastModifiedDate DESC
                  LIMIT ${limit}`;

    const result = await conn.query(soql);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ totalSize: result.totalSize, records: result.records }, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: sf_get_opportunities ──────────────────────────────────────────────
server.tool(
  'sf_get_opportunities',
  'Fetch Salesforce Opportunity records with optional filters.',
  {
    limit: z.number().int().min(1).max(200).optional()
      .describe('Max number of records to return (default 10)'),
    stage: z.string().optional()
      .describe('Filter by StageName, e.g. "Prospecting", "Closed Won"'),
    account_id: z.string().optional()
      .describe('Filter opportunities for a specific Account ID'),
    min_amount: z.number().optional()
      .describe('Filter opportunities with Amount >= this value'),
  },
  async ({ limit = 10, stage, account_id, min_amount }) => {
    const conn = await getConnection();

    const conditions = [];
    if (stage) conditions.push(`StageName = '${stage.replace(/'/g, "\\'")}'`);
    if (account_id) conditions.push(`AccountId = '${account_id}'`);
    if (min_amount != null) conditions.push(`Amount >= ${min_amount}`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const soql = `SELECT Id, Name, StageName, Amount, Probability, CloseDate,
                         AccountId, Account.Name, OwnerId, Owner.Name,
                         Type, LeadSource, Description,
                         CreatedDate, LastModifiedDate
                  FROM Opportunity
                  ${where}
                  ORDER BY CloseDate DESC
                  LIMIT ${limit}`;

    const result = await conn.query(soql);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ totalSize: result.totalSize, records: result.records }, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: sf_get_leads ──────────────────────────────────────────────────────
server.tool(
  'sf_get_leads',
  'Fetch Salesforce Lead records with optional filters.',
  {
    limit: z.number().int().min(1).max(200).optional()
      .describe('Max number of records to return (default 10)'),
    status: z.string().optional()
      .describe('Filter by Status, e.g. "Open - Not Contacted", "Converted"'),
    company_like: z.string().optional()
      .describe('Filter by Company name using LIKE pattern'),
  },
  async ({ limit = 10, status, company_like }) => {
    const conn = await getConnection();

    const conditions = [];
    if (status) conditions.push(`Status = '${status.replace(/'/g, "\\'")}'`);
    if (company_like) conditions.push(`Company LIKE '%${company_like.replace(/'/g, "\\'")}%'`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const soql = `SELECT Id, FirstName, LastName, Email, Phone, Company,
                         Status, LeadSource, Industry, AnnualRevenue,
                         NumberOfEmployees, Rating, Title,
                         CreatedDate, LastModifiedDate
                  FROM Lead
                  ${where}
                  ORDER BY LastModifiedDate DESC
                  LIMIT ${limit}`;

    const result = await conn.query(soql);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ totalSize: result.totalSize, records: result.records }, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: sf_create_record ──────────────────────────────────────────────────
server.tool(
  'sf_create_record',
  'Create a new record in Salesforce.',
  {
    object_type: z.string()
      .describe('Salesforce object API name, e.g. "Account", "Contact", "Lead"'),
    fields: z.record(z.unknown())
      .describe('Object containing field names and values to set on the new record'),
  },
  async ({ object_type, fields }) => {
    const conn = await getConnection();
    const result = await conn.sobject(object_type).create(fields);

    if (!result.success) {
      throw new Error(`Create failed: ${JSON.stringify(result.errors)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, id: result.id, objectType: object_type }, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: sf_update_record ──────────────────────────────────────────────────
server.tool(
  'sf_update_record',
  'Update an existing Salesforce record by ID.',
  {
    object_type: z.string()
      .describe('Salesforce object API name, e.g. "Account", "Contact"'),
    record_id: z.string()
      .describe('The 15- or 18-character Salesforce record ID'),
    fields: z.record(z.unknown())
      .describe('Object containing field names and new values to update'),
  },
  async ({ object_type, record_id, fields }) => {
    const conn = await getConnection();
    const result = await conn.sobject(object_type).update({ Id: record_id, ...fields });

    if (!result.success) {
      throw new Error(`Update failed: ${JSON.stringify(result.errors)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, id: record_id, objectType: object_type }, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: sf_delete_record ──────────────────────────────────────────────────
server.tool(
  'sf_delete_record',
  'Delete a Salesforce record by ID.',
  {
    object_type: z.string()
      .describe('Salesforce object API name, e.g. "Account", "Contact"'),
    record_id: z.string()
      .describe('The Salesforce record ID to delete'),
  },
  async ({ object_type, record_id }) => {
    const conn = await getConnection();
    const result = await conn.sobject(object_type).destroy(record_id);

    if (!result.success) {
      throw new Error(`Delete failed: ${JSON.stringify(result.errors)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, id: record_id, objectType: object_type }, null, 2),
        },
      ],
    };
  }
);

// ─── Tool: sf_describe_object ────────────────────────────────────────────────
server.tool(
  'sf_describe_object',
  'Describe a Salesforce object — returns its fields, picklist values, and relationships.',
  {
    object_type: z.string()
      .describe('Salesforce object API name, e.g. "Account", "Opportunity"'),
  },
  async ({ object_type }) => {
    const conn = await getConnection();
    const meta = await conn.describe(object_type);

    // Return a concise summary rather than the full 100KB+ metadata blob
    const summary = {
      name: meta.name,
      label: meta.label,
      labelPlural: meta.labelPlural,
      keyPrefix: meta.keyPrefix,
      fields: meta.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: !f.nillable && !f.defaultedOnCreate,
        updateable: f.updateable,
        picklistValues: f.picklistValues?.length
          ? f.picklistValues.filter((v) => v.active).map((v) => v.value)
          : undefined,
      })),
      childRelationships: meta.childRelationships
        .filter((r) => r.relationshipName)
        .map((r) => ({ object: r.childSObject, field: r.field, name: r.relationshipName })),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ─── Tool: sf_search ─────────────────────────────────────────────────────────
server.tool(
  'sf_search',
  'Search Salesforce using SOSL (Salesforce Object Search Language) across multiple objects.',
  {
    search_term: z.string()
      .describe('The text to search for'),
    objects: z.array(z.string()).optional()
      .describe('Limit search to these object types, e.g. ["Account", "Contact"]. Defaults to all searchable objects.'),
    limit: z.number().int().min(1).max(200).optional()
      .describe('Max records per object type (default 5)'),
  },
  async ({ search_term, objects, limit = 5 }) => {
    const conn = await getConnection();
    const escaped = search_term.replace(/[?&|!{}[\]()^~*:\\"'+-]/g, '\\$&');

    const returning = objects?.length
      ? objects.map((o) => `${o}(Id, Name LIMIT ${limit})`).join(', ')
      : `Account(Id, Name LIMIT ${limit}), Contact(Id, FirstName, LastName, Email LIMIT ${limit}), Lead(Id, FirstName, LastName, Company LIMIT ${limit}), Opportunity(Id, Name, StageName LIMIT ${limit})`;

    const sosl = `FIND {${escaped}} IN ALL FIELDS RETURNING ${returning}`;
    const result = await conn.search(sosl);

    return {
      content: [{ type: 'text', text: JSON.stringify(result.searchRecords ?? result, null, 2) }],
    };
  }
);

// ─── Tool: sf_get_record ─────────────────────────────────────────────────────
server.tool(
  'sf_get_record',
  'Fetch a single Salesforce record by its ID.',
  {
    object_type: z.string()
      .describe('Salesforce object API name, e.g. "Account"'),
    record_id: z.string()
      .describe('The 15- or 18-character Salesforce record ID'),
    fields: z.array(z.string()).optional()
      .describe('Specific fields to retrieve. Omit to get all fields.'),
  },
  async ({ object_type, record_id, fields }) => {
    const conn = await getConnection();
    const record = fields?.length
      ? await conn.sobject(object_type).retrieve(record_id, fields)
      : await conn.sobject(object_type).retrieve(record_id);

    return {
      content: [{ type: 'text', text: JSON.stringify(record, null, 2) }],
    };
  }
);

// ─── Start (stdio transport) ──────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers communicate over stdio — do NOT write to stdout
  process.stderr.write('Salesforce MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
