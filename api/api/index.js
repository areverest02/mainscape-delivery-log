require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mainscape2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../public')));

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;
const XERO_SCOPES = 'offline_access accounting.contacts.read accounting.contacts accounting.transactions.read accounting.transactions';
app.get('/auth/xero', (req, res) => {
  const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${XERO_CLIENT_ID}&redirect_uri=${encodeURIComponent(XERO_REDIRECT_URI)}&scope=${encodeURIComponent(XERO_SCOPES)}&state=mainscape`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await axios.post('https://identity.xero.com/connect/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: XERO_REDIRECT_URI,
        client_id: XERO_CLIENT_ID,
        client_secret: XERO_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    req.session.tokens = tokenRes.data;
    const tenantsRes = await axios.get('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    req.session.tenantId = tenantsRes.data[0]?.tenantId;
    res.redirect('/?connected=true');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ connected: !!req.session.tokens, tenantId: req.session.tenantId || null });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

async function getValidToken(req) {
  const tokens = req.session.tokens;
  if (!tokens) throw new Error('Not authenticated');
  try {
    const refreshRes = await axios.post('https://identity.xero.com/connect/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: XERO_CLIENT_ID,
        client_secret: XERO_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    req.session.tokens = refreshRes.data;
    return refreshRes.data.access_token;
  } catch {
    return tokens.access_token;
  }
}

app.get('/api/contacts/search', async (req, res) => {
  try {
    const token = await getValidToken(req);
    const { q } = req.query;
    const response = await axios.get(`https://api.xero.com/api.xro/2.0/Contacts?searchTerm=${encodeURIComponent(q)}&includeArchived=false`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-tenant-id': req.session.tenantId,
        Accept: 'application/json'
      }
    });
    const contacts = (response.data.Contacts || []).slice(0, 10).map(c => ({
      id: c.ContactID,
      name: c.Name,
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
    const contactData = {
      Contacts: [{
        Name: name,
        EmailAddress: email || '',
        Phones: phone ? [{ PhoneType: 'MOBILE', PhoneNumber: phone }] : [],
      }]
    };
    const response = await axios.post('https://api.xero.com/api.xro/2.0/Contacts', contactData, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-tenant-id': req.session.tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });
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
    const invoice = {
      Invoices: [{
        Type: 'ACCREC',
        Status: 'DRAFT',
        Contact: { ContactID: contactId },
        Reference: jobAddress,
        LineItems: lineItems,
        LineAmountTypes: 'EXCLUSIVE',
      }]
    };
    const response = await axios.post('https://api.xero.com/api.xro/2.0/Invoices', invoice, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-tenant-id': req.session.tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });
    const inv = response.data.Invoices?.[0];
    res.json({ invoiceId: inv.InvoiceID, invoiceNumber: inv.InvoiceNumber });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mainscape Delivery running on port ${PORT}`));

module.exports = app;
