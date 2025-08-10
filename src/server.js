/*
  Express wrapper over Naukri APIs
  Endpoints:
  - POST /auth/login          → calls central-login-services/v1/login
  - GET  /fetch-profile       → calls resman-aggregator-services/v2/users/self?expand_level=2
  - PUT  /update-profile      → calls resman-aggregator-services/v1/users/self/fullprofiles

  Security & design notes:
  - Headers are hardcoded to mirror the provided cURL specs, except variables are accepted from client:
    username, password, Authorization bearer token, profile, profileId. Cookies are never forwarded.
  - We validate presence of key parameters. We DO NOT log sensitive data.
  - We DO NOT log sensitive data.
*/

const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// Build hardcoded headers per CURLs (no cookies). Only variables are injected from inputs.
const buildLoginHeaders = () => ({
  accept: 'application/json',
  'accept-language': 'en-GB,en;q=0.9',
  appid: '103',
  'cache-control': 'no-cache',
  clientid: 'd3skt0p',
  'content-type': 'application/json',
  origin: 'https://www.naukri.com',
  pragma: 'no-cache',
  priority: 'u=1, i',
  referer: 'https://www.naukri.com/',
  'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  systemid: 'jobseeker',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
});

const buildFetchProfileHeaders = (authorization) => ({
  accept: 'application/json',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7,la;q=0.6',
  appid: '105',
  authorization,
  'cache-control': 'no-cache',
  clientid: 'd3skt0p',
  'content-type': 'application/json',
  pragma: 'no-cache',
  priority: 'u=1, i',
  referer: 'https://www.naukri.com/mnjuser/profile',
  'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  systemid: 'Naukri',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest'
});

const buildUpdateProfileHeaders = (authorization) => ({
  accept: 'application/json',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7,la;q=0.6',
  appid: '105',
  authorization,
  'cache-control': 'no-cache',
  clientid: 'd3skt0p',
  'content-type': 'application/json',
  origin: 'https://www.naukri.com',
  pragma: 'no-cache',
  priority: 'u=1, i',
  referer: 'https://www.naukri.com/mnjuser/profile?action=modalOpen',
  'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  systemid: 'Naukri',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'x-http-method-override': 'PUT',
  'x-requested-with': 'XMLHttpRequest'
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// POST /auth/login
// Body: { username: string, password: string }
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  // Hardcoded headers (no cookies)
  const loginHeaders = buildLoginHeaders();

  try {
    const response = await axios.post(
      'https://www.naukri.com/central-login-services/v1/login',
      { username, password },
      { headers: loginHeaders, timeout: 20000, validateStatus: () => true }
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: 'Login request failed', details: error.message });
  }
});

// GET /fetch-profile
// Query requires: authorization Bearer token in headers
// Optional: we read the incoming headers and pass through the ones present in CURL 2 (excluding Cookie)
app.get('/fetch-profile', async (req, res) => {
  // Require Authorization header (Bearer token)
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.toString().toLowerCase().startsWith('bearer ')) {
    return res.status(400).json({ error: 'Authorization Bearer token header is required' });
  }

  const fetchHeaders = buildFetchProfileHeaders(authHeader);

  try {
    const response = await axios.get(
      'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v2/users/self',
      {
        params: { expand_level: '2' },
        headers: fetchHeaders,
        timeout: 20000,
        validateStatus: () => true
      }
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: 'Fetch profile failed', details: error.message });
  }
});

// PUT /update-profile
// Body must include: { profile: { ... }, profileId: string }
// Requires Authorization header
// Note: Upstream rejects true PUT; it expects POST with x-http-method-override: PUT.
app.put('/update-profile', async (req, res) => {
  const { profile, profileId } = req.body || {};
  if (!profile || typeof profile !== 'object' || !profileId) {
    return res.status(400).json({ error: 'profile (object) and profileId (string) are required' });
  }

  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.toString().toLowerCase().startsWith('bearer ')) {
    return res.status(400).json({ error: 'Authorization Bearer token header is required' });
  }

  const updateHeaders = buildUpdateProfileHeaders(authHeader);

  try {
    const response = await axios.post(
      'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles',
      { profile, profileId },
      { headers: updateHeaders, timeout: 20000, validateStatus: () => true }
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: 'Update profile failed', details: error.message });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});


