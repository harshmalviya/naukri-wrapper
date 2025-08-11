/*
  Express wrapper over Naukri APIs
  Endpoints:
  - POST /auth/login          → calls central-login-services/v1/login
  - POST /auth/login-new      → uses Puppeteer to automate browser login
  - GET  /fetch-profile       → calls resman-aggregator-services/v2/users/self?expand_level=2
  - PUT  /update-profile      → calls resman-aggregator-services/v1/users/self/fullprofiles

  Security & design notes:
  - Headers are hardcoded to mirror the provided cURL specs, except variables are accepted from client:
    username, password, Authorization bearer token, profile, profileId. Cookies are never forwarded.
  - We validate presence of key parameters. We DO NOT log sensitive data.
*/

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// Function to clean up old screenshots (older than 1 day)
const cleanupOldScreenshots = () => {
  try {
    const screenshotDir = getScreenshotDir();
    const files = fs.readdirSync(screenshotDir);
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000); // 24 hours in milliseconds
    
    files.forEach(file => {
      if (file.startsWith('debug-') && file.endsWith('.png')) {
        const filePath = path.join(screenshotDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < oneDayAgo) {
          fs.unlinkSync(filePath);
          console.log(`Deleted old screenshot: ${file}`);
        }
      }
    });
  } catch (error) {
    console.log('Error cleaning up screenshots:', error.message);
  }
};

// Function to generate unique screenshot filename
const generateScreenshotName = (step, sessionId) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `debug-${sessionId}-${step}-${timestamp}.png`;
};

// Get appropriate directory for screenshots based on environment
const getScreenshotDir = () => {
  if (process.env.NODE_ENV === 'production') {
    // On Render, use /tmp directory which is writable
    return '/tmp';
  } else {
    // Local development - use project root
    return __dirname.replace('/src', '');
  }
};

// Helper function to take screenshots with error handling
const takeScreenshot = async (page, step, sessionId) => {
  try {
    const screenshotDir = getScreenshotDir();
    const screenshotPath = path.join(screenshotDir, generateScreenshotName(step, sessionId));
    console.log(`[${sessionId}] Taking screenshot ${step}: ${screenshotPath}`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[${sessionId}] Screenshot ${step} saved successfully`);
    return screenshotPath;
  } catch (screenshotError) {
    console.error(`[${sessionId}] Screenshot ${step} failed:`, screenshotError.message);
    return null;
  }
};

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

// System debug endpoint
app.get('/debug/system', (req, res) => {
  const screenshotDir = getScreenshotDir();
  
  try {
    // Check directory permissions
    const dirExists = fs.existsSync(screenshotDir);
    let canWrite = false;
    let dirContents = [];
    
    if (dirExists) {
      try {
        fs.accessSync(screenshotDir, fs.constants.W_OK);
        canWrite = true;
        dirContents = fs.readdirSync(screenshotDir).filter(f => f.startsWith('debug-'));
      } catch (err) {
        canWrite = false;
      }
    }
    
    res.json({
      environment: process.env.NODE_ENV || 'development',
      screenshotDirectory: screenshotDir,
      directoryExists: dirExists,
      canWrite: canWrite,
      existingScreenshots: dirContents.length,
      screenshots: dirContents.slice(0, 10), // Show first 10
      platform: process.platform,
      nodeVersion: process.version,
      workingDirectory: process.cwd(),
      tmpDirectory: '/tmp',
      tmpExists: fs.existsSync('/tmp'),
      tmpWritable: (() => {
        try {
          fs.accessSync('/tmp', fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })()
    });
  } catch (error) {
    res.status(500).json({
      error: 'System check failed',
      details: error.message
    });
  }
});

// GET /debug/screenshots/:sessionId - View screenshots for a specific session
app.get('/debug/screenshots/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  
  try {
    const screenshotDir = getScreenshotDir();
    const files = fs.readdirSync(screenshotDir);
    
    // Find all screenshots for this session
    const sessionScreenshots = files
      .filter(file => file.startsWith(`debug-${sessionId}-`) && file.endsWith('.png'))
      .sort()
      .map(file => {
        const filePath = path.join(screenshotDir, file);
        const stats = fs.statSync(filePath);
        
        // Extract step info from filename
        const stepMatch = file.match(/debug-.*?-(.*?)-\d{4}/);
        const step = stepMatch ? stepMatch[1] : 'unknown';
        
        return {
          filename: file,
          step: step,
          size: stats.size,
          created: stats.mtime,
          url: `/debug/screenshot/${file}`
        };
      });
    
    if (sessionScreenshots.length === 0) {
      return res.json({ 
        sessionId,
        message: 'No screenshots found for this session',
        screenshots: []
      });
    }
    
    res.json({
      sessionId,
      message: `Found ${sessionScreenshots.length} screenshots`,
      screenshots: sessionScreenshots
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to list screenshots', 
      details: error.message 
    });
  }
});

// GET /debug/screenshot/:filename - Serve individual screenshot file
app.get('/debug/screenshot/:filename', (req, res) => {
  const { filename } = req.params;
  
  // Validate filename to prevent path traversal
  if (!filename || !filename.match(/^debug-.*\.png$/)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  try {
    const screenshotDir = getScreenshotDir();
    const filePath = path.join(screenshotDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }
    
    // Set proper headers for image
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to serve screenshot', 
      details: error.message 
    });
  }
});

// GET /debug/view/:sessionId - HTML interface to view screenshots
app.get('/debug/view/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const screenshotDir = getScreenshotDir();
    const files = fs.readdirSync(screenshotDir);
    
    // Find all screenshots for this session
    const sessionScreenshots = files
      .filter(file => file.startsWith(`debug-${sessionId}-`) && file.endsWith('.png'))
      .sort()
      .map(file => {
        const stepMatch = file.match(/debug-.*?-(.*?)-\d{4}/);
        const step = stepMatch ? stepMatch[1] : 'unknown';
        return { filename: file, step: step };
      });
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Debug Screenshots - Session ${sessionId}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .screenshot { margin: 20px 0; padding: 20px; border: 1px solid #ddd; }
        .screenshot h3 { margin-top: 0; }
        .screenshot img { max-width: 100%; border: 1px solid #ccc; }
    </style>
</head>
<body>
    <h1>Debug Screenshots - Session: ${sessionId}</h1>
    ${sessionScreenshots.length === 0 ? 
      '<p>No screenshots found for this session.</p>' : 
      sessionScreenshots.map(screenshot => `
        <div class="screenshot">
          <h3>Step: ${screenshot.step}</h3>
          <p>Filename: ${screenshot.filename}</p>
          <img src="/debug/screenshot/${screenshot.filename}" alt="${screenshot.step}" />
        </div>
      `).join('')
    }
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to generate debug view', 
      details: error.message 
    });
  }
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

// POST /auth/login-new - Puppeteer-based browser automation login
// Body: { username: string, password: string }
app.post('/auth/login-new', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  // Clean up old screenshots first
  cleanupOldScreenshots();
  
  // Generate unique session ID for this login attempt
  const sessionId = Math.random().toString(36).substring(2, 8);
  
  // Log debugging information
  console.log(`[${sessionId}] Starting login automation`);
  console.log(`[${sessionId}] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[${sessionId}] Screenshot directory: ${getScreenshotDir()}`);
  console.log(`[${sessionId}] Directory writable:`, fs.access ? 'checking...' : 'unknown');

  let browser;
  try {
    // Launch browser in headless mode with stealth configuration
    const browserOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
        '--single-process',
        '--no-zygote'
      ]
    };

    // Configure Chrome executable path for different environments
    if (process.env.NODE_ENV === 'production') {
      // Try multiple possible Chrome paths on Render
      const possiblePaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/opt/render/.cache/puppeteer/chrome/linux-*/chrome-linux*/chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
      ];
      
      for (const chromePath of possiblePaths) {
        if (chromePath && fs.existsSync(chromePath.replace('*', ''))) {
          browserOptions.executablePath = chromePath;
          console.log(`Using Chrome at: ${chromePath}`);
          break;
        }
      }
    } else {
      // For local development, let Puppeteer find the installed Chrome
      // The npx puppeteer browsers install chrome command should handle this
      console.log('Using locally installed Puppeteer Chrome');
    }

    console.log(`[${sessionId}] Launching browser...`);
    browser = await puppeteer.launch(browserOptions);
    console.log(`[${sessionId}] Browser launched successfully`);
    
    const page = await browser.newPage();
    console.log(`[${sessionId}] New page created`);
    
    // Remove automation indicators
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      // Remove chrome automation extension
      delete window.chrome.loadTimes;
      delete window.chrome.csi;
      
      // Spoof plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      
      // Spoof languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      
      // Spoof permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: 'granted' }) :
          originalQuery(parameters)
      );
    });
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set additional headers to mimic real browser
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });
    
    // Set viewport for consistent screenshots
    await page.setViewport({ width: 1280, height: 720 });
    
    // Navigate to Naukri
    console.log(`[${sessionId}] Navigating to naukri.com...`);
    await page.goto('https://www.naukri.com/', { waitUntil: 'networkidle0' });
    console.log(`[${sessionId}] Page loaded, current URL: ${page.url()}`);
    
    // Take screenshot after page load
    await takeScreenshot(page, '01-pageload', sessionId);
    
    // Click on "Jobseeker Login" link with title="Jobseeker Login" and innerHTML "Login"
    await page.click('a[title="Jobseeker Login"]');
    
    // Wait for dialog to open
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Take screenshot after clicking login link
    await takeScreenshot(page, '02-after-click', sessionId);
    
    // Find form rows and fill inputs
    const formRows = await page.$$('.form-row');
    
    if (formRows.length < 2) {
      throw new Error('Could not find username and password form fields');
    }
    
    // Fill username (first form-row)
    const usernameInput = await formRows[0].$('input');
    if (usernameInput) {
      await usernameInput.type(username);
    } else {
      throw new Error('Could not find username input field');
    }
    
    // Fill password (second form-row)  
    const passwordInput = await formRows[1].$('input');
    if (passwordInput) {
      await passwordInput.type(password);
    } else {
      throw new Error('Could not find password input field');
    }
    
    // Take screenshot before clicking login button
    await takeScreenshot(page, '03-before-login', sessionId);
    
    // Click login button
    await page.click('button.btn-primary.loginButton');
    
    // Wait for login to complete - look for redirect or success indicators
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 });
    
    // Take screenshot after login
    await takeScreenshot(page, '04-after-login', sessionId);
    
    // Get cookies and current URL from the logged-in session
    const cookies = await page.cookies();
    const currentUrl = page.url();
    
    // Extract any relevant session data
    const sessionData = {
      success: true,
      message: 'Login completed successfully',
      sessionId: sessionId,
      url: currentUrl,
      cookies: cookies.map(cookie => ({ 
        name: cookie.name, 
        value: cookie.value, 
        domain: cookie.domain 
      }))
    };
    
    res.json(sessionData);
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Browser automation login failed', 
      details: error.message,
      sessionId: sessionId
    });
  } finally {
    if (browser) {
      await browser.close();
    }
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


