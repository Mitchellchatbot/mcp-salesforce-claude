'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const jsforce = require('jsforce');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Validate required env vars ──────────────────────────────────────────────
const REQUIRED_ENV = [
  'SF_CLIENT_ID',
  'SF_CLIENT_SECRET',
  'SF_REDIRECT_URI',
  'ANTHROPIC_API_KEY',
  'SESSION_SECRET',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

// ─── Clients ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2 = new jsforce.OAuth2({
  loginUrl: SF_LOGIN_URL,
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  redirectUri: process.env.SF_REDIRECT_URI,
});

// ─── App setup ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // set true if using HTTPS in production
  })
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a jsforce Connection authenticated with the tokens stored in session.
 * Throws an error if the session has no tokens.
 */
function getConnection(req) {
  const { accessToken, instanceUrl } = req.session;
  if (!accessToken || !instanceUrl) {
    const err = new Error('Not authenticated with Salesforce. Visit /oauth/login first.');
    err.status = 401;
    throw err;
  }
  return new jsforce.Connection({ accessToken, instanceUrl });
}

/**
 * Fetch Salesforce Account records and return them as plain objects.
 * @param {jsforce.Connection} conn
 * @param {number} limit  Max records to retrieve (default 10)
 */
async function fetchAccounts(conn, limit = 10) {
  const result = await conn.query(
    `SELECT Id, Name, Industry, AnnualRevenue, NumberOfEmployees, BillingCity, BillingCountry,
            Phone, Website, Type, Description
     FROM Account
     ORDER BY LastModifiedDate DESC
     LIMIT ${parseInt(limit, 10)}`
  );
  return result.records;
}

/**
 * Send Salesforce account data to Claude for analysis.
 * Uses streaming so long outputs don't time out.
 * @param {object[]} accounts
 * @returns {Promise<string>} Claude's analysis text
 */
async function analyzeWithClaude(accounts) {
  const accountSummary = JSON.stringify(accounts, null, 2);

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system:
      'You are a Salesforce CRM analyst. When given account data, provide a concise business analysis covering: ' +
      'industry distribution, revenue insights, employee size segmentation, geographic spread, ' +
      'notable trends, and 2–3 actionable recommendations. Be specific and data-driven.',
    messages: [
      {
        role: 'user',
        content: `Analyze the following ${accounts.length} Salesforce Account records and provide business insights:\n\n${accountSummary}`,
      },
    ],
  });

  const finalMessage = await stream.finalMessage();
  const textBlock = finalMessage.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '(no text response from Claude)';
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /
app.get('/', (_req, res) => {
  res.json({
    message: 'Salesforce ↔ Claude integration server',
    endpoints: {
      'GET /oauth/login': 'Start Salesforce OAuth2 flow',
      'GET /oauth/callback': 'OAuth2 callback (handled automatically)',
      'GET /oauth/status': 'Check authentication status',
      'GET /oauth/logout': 'Clear Salesforce session',
      'GET /salesforce/accounts': 'Fetch Salesforce Accounts (query param: limit)',
      'GET /salesforce/accounts/analyze': 'Fetch accounts + Claude analysis (query param: limit)',
      'POST /analyze': 'Send custom account data to Claude for analysis',
    },
  });
});

// GET /oauth/login – redirect user to Salesforce
app.get('/oauth/login', (_req, res) => {
  const authUrl = oauth2.getAuthorizationUrl({ scope: 'api refresh_token offline_access' });
  res.redirect(authUrl);
});

// GET /oauth/callback – exchange code for tokens
app.get('/oauth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({ error, error_description });
  }
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const conn = new jsforce.Connection({ oauth2 });
    await conn.authorize(code);

    req.session.accessToken = conn.accessToken;
    req.session.refreshToken = conn.refreshToken;
    req.session.instanceUrl = conn.instanceUrl;

    res.json({
      message: 'Salesforce authentication successful',
      instanceUrl: conn.instanceUrl,
      hint: 'You can now call /salesforce/accounts or /salesforce/accounts/analyze',
    });
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).json({ error: 'OAuth authorization failed', details: err.message });
  }
});

// GET /oauth/status – check if session has tokens
app.get('/oauth/status', (req, res) => {
  const authenticated = !!(req.session.accessToken && req.session.instanceUrl);
  res.json({
    authenticated,
    instanceUrl: authenticated ? req.session.instanceUrl : null,
  });
});

// GET /oauth/logout – clear session tokens
app.get('/oauth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Salesforce session cleared' });
  });
});

// GET /salesforce/accounts – fetch accounts from Salesforce
app.get('/salesforce/accounts', async (req, res) => {
  try {
    const conn = getConnection(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 200);
    const accounts = await fetchAccounts(conn, limit);

    res.json({
      total: accounts.length,
      accounts,
    });
  } catch (err) {
    const status = err.status || 500;
    console.error('Fetch accounts error:', err);
    res.status(status).json({ error: err.message });
  }
});

// GET /salesforce/accounts/analyze – fetch accounts and run Claude analysis
app.get('/salesforce/accounts/analyze', async (req, res) => {
  try {
    const conn = getConnection(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 200);

    const accounts = await fetchAccounts(conn, limit);
    if (accounts.length === 0) {
      return res.json({ message: 'No accounts found', analysis: null });
    }

    const analysis = await analyzeWithClaude(accounts);

    res.json({
      accountsFetched: accounts.length,
      accounts,
      analysis,
    });
  } catch (err) {
    const status = err.status || 500;
    console.error('Analyze accounts error:', err);
    res.status(status).json({ error: err.message });
  }
});

// POST /analyze – send custom account data to Claude (no Salesforce required)
app.post('/analyze', async (req, res) => {
  const { accounts } = req.body;

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: '`accounts` must be a non-empty array in the request body' });
  }
  if (accounts.length > 200) {
    return res.status(400).json({ error: 'Maximum 200 accounts per request' });
  }

  try {
    const analysis = await analyzeWithClaude(accounts);
    res.json({ accountsAnalyzed: accounts.length, analysis });
  } catch (err) {
    console.error('Claude analysis error:', err);
    res.status(500).json({ error: 'Claude analysis failed', details: err.message });
  }
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`  1. Visit http://localhost:${PORT}/oauth/login to authenticate with Salesforce`);
  console.log(`  2. Then call http://localhost:${PORT}/salesforce/accounts/analyze`);
});
