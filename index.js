require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;
const XERO_SCOPES = 'app.connections accounting.contacts accounting.contacts.read accounting.invoices accounting.invoices.read';

function setTokenCookie(res, data) {
  const val = JSON.stringify(data);
  const b64 = Buffer.from(val).toString('base64');
  res.setHeader('Set-Cookie', `xero_auth=${b64}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
}

function getTokenCookie(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/xero_auth=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(Buffer.from(match[1], 'base64').toString()); } catch { return null; }
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

    const authData = {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      tenantId: tenantsRes.data[0]?.tenantId
    };

    setTokenCookie(res, authData);
    res.redirect('/?connected=true');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  const auth = getTokenCookie(req);
  res.json({ connected: !!auth?.access_token });
});

app.get('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'xero_auth=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

async function getValidToken(req) {
  const auth = getTokenCookie(req);
  if (!auth) throw new Error('Not authenticated');
  return auth.access_token;
}

function getTenantId(req) {
  const auth = getTokenCookie(req);
  return auth?.tenantId;
}

app.get('/api/contacts/search', async (req, res) => {
  try {
    const token = await getValidToken(req);
    const { q } = req.query;
    const response = await axios.get(`https://api.xero.com/api.xro/2.0/Contacts?searchTerm=${encodeURIComponent(q)}&includeArchived=false`, {
      headers: { Authorization: `Bearer ${token}`, 'Xero-tenant-id': getTenantId(req), Accept: 'application/json' }
    });
    const contacts = (response.data.Contacts || []).slice(0, 10).map(c => ({
      id: c.ContactID, name: c.Name,
      phone: c.Phones?.find(p => p.PhoneType === 'MOBILE')?.PhoneNumber || c.Phones?.[0]?.PhoneNumber || '',
      email: c.EmailAddress || '',
    }));
    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search contacts' });
  }
});

app.post('/api/contacts', async (req, res) => {
  try {
    const token = await getValidToken(req);
    const { name, phone, email } = req.body;
    const response = await axios.post('https://api.xero.com/api.xro/2.0/Contacts',
      { Contacts: [{ Name: name, EmailAddress: email || '', Phones: phone ? [{ PhoneType: 'MOBILE', PhoneNumber: phone }] : [] }] },
      { headers: { Authorization: `Bearer ${token}`, 'Xero-tenant-id': getTenantId(req), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    const c = response.data.Contacts?.[0];
    res.json({ id: c.ContactID, name: c.Name, phone, email });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

app.post('/api/invoices', async (req, res) => {
  try {
    const token = await getValidToken(req);
    const { contactId, deliveries, jobAddress } = req.body;
    const lineItems = [];
    for (const d of deliveries) {
      for (const li of (d.lineItems || [])) {
        lineItems.push({ Description: li.desc, Quantity: li.qty, UnitAmount: li.price, AccountCode: '200' });
      }
      if (d.zoneFee > 0) {
        lineItems.push({ Description: `Delivery – ${d.zone} (${d.truck})`, Quantity: 1, UnitAmount: d.zoneFee, AccountCode: '200' });
      }
    }
    const response = await axios.post('https://api.xero.com/api.xro/2.0/Invoices',
      { Invoices: [{ Type: 'ACCREC', Status: 'DRAFT', Contact: { ContactID: contactId }, Reference: jobAddress, LineItems: lineItems, LineAmountTypes: 'EXCLUSIVE' }] },
      { headers: { Authorization: `Bearer ${token}`, 'Xero-tenant-id': getTenantId(req), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    const inv = response.data.Invoices?.[0];
    res.json({ invoiceId: inv.InvoiceID, invoiceNumber: inv.InvoiceNumber });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mainscape Delivery running on port ${PORT}`));

module.exports = app;
