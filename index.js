require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { Client } = require('pg');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;
const XERO_SCOPES = 'offline_access accounting.contacts accounting.contacts.read accounting.invoices accounting.invoices.read accounting.settings.read';

async function getDb() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS xero_tokens (id INTEGER PRIMARY KEY DEFAULT 1, access_token TEXT, refresh_token TEXT, tenant_id TEXT, updated_at TIMESTAMP DEFAULT NOW())`);
  return client;
}

async function saveTokens(access_token, refresh_token, tenant_id) {
  const db = await getDb();
  await db.query(`INSERT INTO xero_tokens (id, access_token, refresh_token, tenant_id) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO UPDATE SET access_token=$1, refresh_token=$2, tenant_id=$3, updated_at=NOW()`, [access_token, refresh_token, tenant_id]);
  await db.end();
}

async function getTokens() {
  try {
    const db = await getDb();
    const result = await db.query('SELECT * FROM xero_tokens WHERE id=1');
    await db.end();
    return result.rows[0] || null;
  } catch (e) {
    console.error('getTokens error:', e.message);
    return null;
  }
}

async function getValidToken() {
  const tokens = await getTokens();
  if (!tokens) throw new Error('Not authenticated');
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', tokens.refresh_token);
    params.append('client_id', XERO_CLIENT_ID);
    params.append('client_secret', XERO_CLIENT_SECRET);
    const refreshRes = await axios.post(
      'https://identity.xero.com/connect/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    await saveTokens(refreshRes.data.access_token, refreshRes.data.refresh_token, tokens.tenant_id);
    return { access_token: refreshRes.data.access_token, tenant_id: tokens.tenant_id };
  } catch (e) {
    console.error('Refresh error:', e.response?.data || e.message);
    return { access_token: tokens.access_token, tenant_id: tokens.tenant_id };
  }
}

app.get('/auth/xero', (req, res) => {
  const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${XERO_CLIENT_ID}&redirect_uri=${encodeURIComponent(XERO_REDIRECT_URI)}&scope=${encodeURIComponent(XERO_SCOPES)}&state=mainscape`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=auth_failed');
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', XERO_REDIRECT_URI);
    params.append('client_id', XERO_CLIENT_ID);
    params.append('client_secret', XERO_CLIENT_SECRET);
    const tokenRes = await axios.post(
      'https://identity.xero.com/connect/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const tenantsRes = await axios.get('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    const tenantId = tenantsRes.data[0]?.tenantId;
    await saveTokens(tokenRes.data.access_token, tokenRes.data.refresh_token, tenantId);
    res.redirect('/?connected=true');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', async (req, res) => {
  const tokens = await getTokens();
  res.json({ connected: !!tokens?.access_token });
});

app.get('/auth/logout', async (req, res) => {
  try {
    const db = await getDb();
    await db.query('DELETE FROM xero_tokens WHERE id=1');
    await db.end();
  } catch (e) {}
  res.json({ ok: true });
});

app.get('/api/products', async (req, res) => {
  try {
    const { access_token, tenant_id } = await getValidToken();
    const response = await axios.get('https://api.xero.com/api.xro/2.0/Items', {
      headers: { Authorization: `Bearer ${access_token}`, 'Xero-tenant-id': tenant_id, Accept: 'application/json' }
    });
    const products = (response.data.Items || []).map(item => ({
      sku: item.Code,
      name: item.Name,
      price: item.SalesDetails?.UnitPrice || 0,
      description: item.Description || item.Name
    })).filter(p => p.price > 0);
    res.json({ products });
  } catch (err) {
    console.error('Products error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/api/contacts/search', async (req, res) => {
  try {
    const { access_token, tenant_id } = await getValidToken();
    const { q } = req.query;
    const response = await axios.get(`https://api.xero.com/api.xro/2.0/Contacts?searchTerm=${encodeURIComponent(q)}&includeArchived=false`, {
      headers: { Authorization: `Bearer ${access_token}`, 'Xero-tenant-id': tenant_id, Accept: 'application/json' }
    });
    const contacts = (response.data.Contacts || []).slice(0, 10).map(c => ({
      id: c.ContactID, name: c.Name,
      phone: c.Phones?.find(p => p.PhoneType === 'MOBILE')?.PhoneNumber || c.Phones?.[0]?.PhoneNumber || '',
      email: c.EmailAddress || '',
    }));
    res.json({ contacts });
  } catch (err) {
    console.error('Contact search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to search contacts' });
  }
});

app.post('/api/contacts', async (req, res) => {
  try {
    const { access_token, tenant_id } = await getValidToken();
    const { name, phone, email } = req.body;
    const response = await axios.post('https://api.xero.com/api.xro/2.0/Contacts',
      { Contacts: [{ Name: name, EmailAddress: email || '', Phones: phone ? [{ PhoneType: 'MOBILE', PhoneNumber: phone }] : [] }] },
      { headers: { Authorization: `Bearer ${access_token}`, 'Xero-tenant-id': tenant_id, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    const c = response.data.Contacts?.[0];
    res.json({ id: c.ContactID, name: c.Name, phone, email });
  } catch (err) {
    console.error('Create contact error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

app.post('/api/invoices', async (req, res) => {
  try {
    const { access_token, tenant_id } = await getValidToken();
    const { contactId, contactName, deliveries, jobAddress } = req.body;
    const lineItems = [];
    for (const d of deliveries) {
      for (const li of (d.lineItems || [])) {
        lineItems.push({ Description: li.desc, Quantity: li.qty, UnitAmount: li.price });
      }
      if (d.zoneFee > 0) {
        lineItems.push({ Description: `Delivery - ${d.zone} (${d.truck})`, Quantity: 1, UnitAmount: d.zoneFee });
      }
    }
    const invoiceData = {
      Invoices: [{
        Type: 'ACCREC',
        Status: 'DRAFT',
        Contact: contactId ? { ContactID: contactId } : { Name: contactName },
        Reference: jobAddress,
        LineItems: lineItems
      }]
    };
    const response = await axios.post('https://api.xero.com/api.xro/2.0/Invoices',
      invoiceData,
      { headers: { Authorization: `Bearer ${access_token}`, 'Xero-tenant-id': tenant_id, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    const inv = response.data.Invoices?.[0];
    if (inv?.HasErrors) {
      return res.status(500).json({ error: inv.ValidationErrors?.[0]?.Message || 'Validation error' });
    }
    res.json({ invoiceId: inv.InvoiceID, invoiceNumber: inv.InvoiceNumber });
  } catch (err) {
    console.error('Invoice error:', err.response?.data || err.message);
    res.status(500).json({ error: JSON.stringify(err.response?.data) || err.message || 'Failed to create invoice' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mainscape Delivery running on port ${PORT}`));

module.exports = app;
