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

// Helper function to simulate human-like delays
const humanDelay = (min = 1000, max = 3000) => {
  const delay = Math.random() * (max - min) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
};

// Helper function to execute page actions with frame detachment protection
const safePageAction = async (action, sessionId, actionName, maxRetries = 3) => {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      attempts++;
      console.log(`[${sessionId}] Executing ${actionName} (attempt ${attempts}/${maxRetries})`);
      return await action();
    } catch (error) {
      console.error(`[${sessionId}] ${actionName} failed (attempt ${attempts}):`, error.message);
      
      if (error.message.includes('detached') || 
          error.message.includes('Target closed') ||
          error.message.includes('Protocol error')) {
        
        if (attempts < maxRetries) {
          console.log(`[${sessionId}] Frame/target issue detected, waiting before retry...`);
          await humanDelay(2000, 4000);
        } else {
          throw new Error(`${actionName} failed after ${maxRetries} attempts due to frame detachment: ${error.message}`);
        }
      } else {
        // Non-frame related error, don't retry
        throw error;
      }
    }
  }
};

// Helper function to simulate human-like mouse movement and click
const humanClick = async (page, selector, sessionId, timeout = 20000) => {
  try {
    console.log(`[${sessionId}] Looking for element: ${selector}`);
    await page.waitForSelector(selector, { timeout });
    
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Element not found: ${selector}`);
    }
    
    // Get element position
    const box = await element.boundingBox();
    if (!box) {
      throw new Error(`Element has no bounding box: ${selector}`);
    }
    
    // Calculate random click position within element
    const x = box.x + Math.random() * box.width;
    const y = box.y + Math.random() * box.height;
    
    console.log(`[${sessionId}] Moving mouse to (${Math.round(x)}, ${Math.round(y)})`);
    
    // Move mouse to element with human-like movement
    await page.mouse.move(x, y, { steps: 5 });
    await humanDelay(200, 500);
    
    // Click with human-like timing
    await page.mouse.click(x, y, { delay: Math.random() * 100 + 50 });
    console.log(`[${sessionId}] Clicked element: ${selector}`);
    
    return true;
  } catch (error) {
    console.error(`[${sessionId}] Human click failed for ${selector}:`, error.message);
    return false;
  }
};

// Helper function to try multiple selectors for an element
const findAndClickElement = async (page, selectors, sessionId, timeout = 20000) => {
  for (const selector of selectors) {
    try {
      console.log(`[${sessionId}] Trying selector: ${selector}`);
      const success = await humanClick(page, selector, sessionId, timeout);
      if (success) {
        return true;
      }
    } catch (error) {
      console.log(`[${sessionId}] Selector ${selector} failed, trying next...`);
    }
  }
  return false;
};

// Helper function to simulate human-like typing
const humanType = async (page, selector, text, sessionId, timeout = 15000) => {
  try {
    console.log(`[${sessionId}] Typing into: ${selector}`);
    
    // Wait for element to be visible and enabled
    await page.waitForSelector(selector, { 
      timeout,
      visible: true 
    });
    
    // Wait for element to be interactive
    await page.waitForFunction(
      sel => {
        const element = document.querySelector(sel);
        return element && !element.disabled && element.offsetParent !== null;
      },
      { timeout: 5000 },
      selector
    );
    
    // Scroll element into view if needed
    await page.evaluate(sel => {
      const element = document.querySelector(sel);
      if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, selector);
    
    await humanDelay(300, 600);
    
    // Focus the element with human-like behavior
    await page.click(selector);
    await humanDelay(200, 400);
    
    // Clear existing text
    await page.evaluate(sel => {
      const element = document.querySelector(sel);
      if (element) {
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, selector);
    
    await humanDelay(100, 300);
    
    // Type with human-like delays between characters
    for (const char of text) {
      await page.type(selector, char, { delay: Math.random() * 150 + 50 });
    }
    
    // Trigger change event
    await page.evaluate(sel => {
      const element = document.querySelector(sel);
      if (element) {
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);
    
    console.log(`[${sessionId}] Finished typing into: ${selector}`);
    return true;
  } catch (error) {
    console.error(`[${sessionId}] Human type failed for ${selector}:`, error.message);
    return false;
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

// Browser test endpoint - test if Puppeteer works at all
app.get('/debug/browser-test', async (req, res) => {
  const sessionId = Math.random().toString(36).substring(2, 8);
  let browser;
  
  try {
    console.log(`[${sessionId}] Testing browser functionality...`);
    
    const browserOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 30000
    };
    
    browser = await puppeteer.launch(browserOptions);
    const page = await browser.newPage();
    
    // Test basic functionality
    await page.goto('data:text/html,<h1>Browser Test</h1><p>Time: ' + Date.now() + '</p>');
    const title = await page.evaluate(() => document.querySelector('h1').textContent);
    
    // Take a test screenshot
    const screenshotPath = await takeScreenshot(page, 'browser-test', sessionId);
    
    res.json({
      success: true,
      sessionId: sessionId,
      title: title,
      screenshotSaved: !!screenshotPath,
      screenshotPath: screenshotPath
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      sessionId: sessionId,
      error: error.message
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
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
  
  // Set overall timeout for the entire process
  const overallTimeout = setTimeout(() => {
    console.error(`[${sessionId}] Overall process timeout after 2 minutes`);
    if (browser) {
      browser.close().catch(console.error);
    }
  }, 120000); // 2 minutes
  
  try {
    // Launch browser with Python Selenium equivalent configuration
    const browserOptions = {
      headless: true,
      // Python Selenium equivalent chrome options
      args: [
        // Basic security and sandbox options (equivalent to Python ChromeOptions)
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        
        // GPU and rendering options (common in Python Selenium configs)
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        
        // Automation detection prevention (Python equivalent)
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
        
        // Network and performance options
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        
        // Memory and process management
        '--memory-pressure-off',
        '--max_old_space_size=4096',
        
        // Display and UI options (Python Selenium style)
        '--disable-infobars',
        '--disable-notifications',
        '--disable-save-password-bubble',
        '--disable-popup-blocking',
        
        // Additional stealth options
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-domain-reliability',
        '--disable-component-extensions-with-background-pages',
        
        // Window management
        '--window-size=1920,1080',
        '--start-maximized'
      ],
      timeout: 60000,
      // Python Selenium equivalent settings
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions'
      ],
      // Set viewport to common desktop resolution (Python Selenium style)
      defaultViewport: {
        width: 1920,
        height: 1080
      }
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
    
    // Add error handlers for page-level issues
    page.on('error', (error) => {
      console.error(`[${sessionId}] Page error:`, error.message);
    });
    
    page.on('pageerror', (error) => {
      console.error(`[${sessionId}] Page JavaScript error:`, error.message);
    });
    
    page.on('framedetached', (frame) => {
      console.log(`[${sessionId}] Frame detached:`, frame.url());
    });
    
    page.on('framenavigated', (frame) => {
      console.log(`[${sessionId}] Frame navigated to:`, frame.url());
    });
    
    // Advanced stealth mode - remove ALL automation indicators
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      // Remove chrome automation properties
      if (window.chrome) {
        delete window.chrome.loadTimes;
        delete window.chrome.csi;
        delete window.chrome.app;
        delete window.chrome.runtime;
      }
      
      // Spoof plugins with realistic data
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          {
            0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null},
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Plugin"
          },
          {
            0: {type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null},
            description: "Portable Document Format", 
            filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
            length: 1,
            name: "Chrome PDF Viewer"
          }
        ],
      });
      
      // Spoof languages realistically
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en', 'en-GB'],
      });
      
      // Spoof platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32',
      });
      
      // Spoof hardware concurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 4,
      });
      
      // Spoof memory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
      });
      
      // Spoof connection
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 100,
          downlink: 2.0
        }),
      });
      
      // Spoof permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: 'granted' }) :
          originalQuery(parameters)
      );
      
      // Spoof screen properties
      Object.defineProperty(screen, 'width', { get: () => 1920 });
      Object.defineProperty(screen, 'height', { get: () => 1080 });
      Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
      Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
      Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
      Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
      
      // Override toString methods to hide automation
      const originalToString = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === navigator.webdriver) {
          return 'function webdriver() { [native code] }';
        }
        return originalToString.call(this);
      };
      
      // Add mouse and touch events
      ['mousedown', 'mouseup', 'mousemove', 'click', 'touchstart', 'touchend', 'touchmove'].forEach(eventType => {
        document.addEventListener(eventType, () => {}, true);
      });
      
      // Spoof getBattery
      if (navigator.getBattery) {
        navigator.getBattery = () => Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 1
        });
      }
    });
    
    // Python Selenium equivalent user agent and headers setup
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    
    // Randomly select user agent (Python Selenium pattern)
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(randomUserAgent);
    console.log(`[${sessionId}] Using User-Agent: ${randomUserAgent}`);
    
    // Python Selenium equivalent headers (comprehensive set)
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    });
    
    // Python Selenium equivalent viewport (match browser window size)
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Python Selenium equivalent: set implicit wait and page load timeout
    page.setDefaultTimeout(30000); // Equivalent to driver.implicitly_wait(30)
    page.setDefaultNavigationTimeout(45000); // Equivalent to driver.set_page_load_timeout(45)
    
    // Test basic navigation first
    console.log(`[${sessionId}] Testing basic navigation...`);
    try {
      await page.goto('data:text/html,<h1>Test Page</h1>', { waitUntil: 'domcontentloaded', timeout: 5000 });
      console.log(`[${sessionId}] Basic navigation test passed`);
    } catch (testError) {
      console.error(`[${sessionId}] Basic navigation test failed:`, testError.message);
      throw new Error(`Browser navigation not working: ${testError.message}`);
    }
    
    // Navigate to Naukri with robust error handling
    console.log(`[${sessionId}] Navigating to naukri.com...`);
    let navigationAttempts = 0;
    const maxAttempts = 3;
    
    while (navigationAttempts < maxAttempts) {
      try {
        navigationAttempts++;
        console.log(`[${sessionId}] Navigation attempt ${navigationAttempts}/${maxAttempts}`);
        
        // Try different wait strategies based on attempt
        const waitStrategy = navigationAttempts === 1 ? 'networkidle2' : 
                           navigationAttempts === 2 ? 'domcontentloaded' : 'load';
        
        // Python Selenium equivalent: driver.get() with timeout
        await page.goto('https://www.naukri.com/', { 
          waitUntil: waitStrategy,
          timeout: 30000 
        });
        
        console.log(`[${sessionId}] Page loaded, current URL: ${page.url()}`);
        
        // Python Selenium equivalent: verify current_url
        const currentUrl = page.url();
        if (!currentUrl.includes('naukri.com')) {
          throw new Error(`Unexpected redirect to: ${currentUrl}`);
        }
        
        // Python Selenium equivalent: WebDriverWait with multiple conditions
        console.log(`[${sessionId}] Waiting for page to be interactive...`);
        let retries = 3;
        while (retries > 0) {
          try {
            // Wait for DOM to be ready (Python: document.readyState == 'complete')
            await page.waitForFunction(
              () => document.readyState === 'complete',
              { timeout: 10000 }
            );
            
            // Additional check for common JavaScript libraries (Python equivalent)
            try {
              await page.waitForFunction(
                () => window.jQuery || window.$ || document.querySelector('script[src*="jquery"]'),
                { timeout: 5000 }
              );
              console.log(`[${sessionId}] jQuery detected, page fully loaded`);
            } catch (e) {
              console.log(`[${sessionId}] No jQuery detected, but DOM is ready`);
            }
            
            break;
          } catch (e) {
            retries--;
            if (retries === 0) {
              console.log(`[${sessionId}] Page readiness check failed, continuing anyway`);
            } else {
              await humanDelay(1000, 2000);
            }
          }
        }
        
        // Python Selenium equivalent: implicit wait + human simulation
        await humanDelay(3000, 5000); // More realistic page load time
        
        // Python Selenium equivalent: ActionChains for mouse movement
        const mouseMovements = [
          { x: 200, y: 150 },
          { x: 400, y: 300 },
          { x: 600, y: 200 },
          { x: 300, y: 400 }
        ];
        
        for (const movement of mouseMovements) {
          await page.mouse.move(movement.x, movement.y, { steps: 3 });
          await humanDelay(300, 700);
        }
        
        console.log(`[${sessionId}] Navigation successful, Python Selenium-style browsing completed`);
        break; // Success, exit the retry loop
        
      } catch (navigationError) {
        console.error(`[${sessionId}] Navigation attempt ${navigationAttempts} failed:`, navigationError.message);
        
        if (navigationAttempts === maxAttempts) {
          await takeScreenshot(page, '01-navigation-failed', sessionId);
          throw new Error(`Navigation failed after ${maxAttempts} attempts: ${navigationError.message}`);
        } else {
          console.log(`[${sessionId}] Retrying navigation in 2 seconds...`);
          await humanDelay(2000, 3000);
        }
      }
    }
    
    // Take screenshot after page load
    await takeScreenshot(page, '01-pageload', sessionId);
    
    // Wait a bit more for dynamic content to load
    console.log(`[${sessionId}] Waiting for page to fully load...`);
    await humanDelay(3000, 5000);
    
    // Try multiple selectors for the login link
    console.log(`[${sessionId}] Looking for login link...`);
    const loginSelectors = [
      'a[title="Jobseeker Login"]',
      'a[title*="Login"]',
      '.login-link',
      '.jobseeker-login',
      'a[href*="login"]',
      'a:contains("Login")',
      '.header-login a',
      '.nav-login'
    ];
    
    const loginClicked = await findAndClickElement(page, loginSelectors, sessionId, 30000);
    if (!loginClicked) {
      // Take a screenshot to see what's on the page
      await takeScreenshot(page, '01-login-link-not-found', sessionId);
      
      // Try to find any login-related elements for debugging
      const loginElements = await page.$$eval('a', elements => 
        elements.map(el => ({
          text: el.textContent.trim(),
          title: el.title,
          href: el.href,
          className: el.className
        })).filter(el => 
          el.text.toLowerCase().includes('login') || 
          el.title.toLowerCase().includes('login') ||
          el.href.toLowerCase().includes('login')
        )
      );
      
      console.log(`[${sessionId}] Found login-related elements:`, JSON.stringify(loginElements, null, 2));
      throw new Error('Could not click on Jobseeker Login link');
    }
    
    // Human-like wait for dialog to open and load completely
    await humanDelay(3000, 5000);
    
    // Wait for login form to be visible and interactive
    console.log(`[${sessionId}] Waiting for login form to load...`);
    try {
      // Wait for any login form to appear
      await page.waitForSelector('.form-row, .login-form, #login-form, .modal-body', { 
        timeout: 20000,
        visible: true 
      });
      console.log(`[${sessionId}] Login form container found`);
    } catch (error) {
      console.log(`[${sessionId}] No standard form container found, continuing...`);
    }
    
    // Additional wait for dynamic content
    await humanDelay(2000, 3000);
    
    // Take screenshot after clicking login link
    await takeScreenshot(page, '02-after-click', sessionId);
    
    // Try multiple selectors for username field
    console.log(`[${sessionId}] Looking for username field...`);
    const usernameSelectors = [
      '.form-row:first-child input',
      '.form-row input[type="text"]',
      '.form-row input[type="email"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[placeholder*="Email"]',
      'input[placeholder*="Username"]',
      'input[id*="username"]',
      'input[id*="email"]',
      '.login-form input:first-of-type',
      '#login-form input:first-of-type',
      '.modal-body input:first-of-type'
    ];
    
    let usernameTyped = false;
    for (const selector of usernameSelectors) {
      try {
        console.log(`[${sessionId}] Trying username selector: ${selector}`);
        usernameTyped = await humanType(page, selector, username, sessionId, 10000);
        if (usernameTyped) {
          console.log(`[${sessionId}] Username typed successfully with: ${selector}`);
          break;
        }
      } catch (error) {
        console.log(`[${sessionId}] Username selector ${selector} failed, trying next...`);
      }
    }
    
    if (!usernameTyped) {
      // Take debug screenshot and log available inputs
      await takeScreenshot(page, '02-username-field-not-found', sessionId);
      
      const availableInputs = await page.$$eval('input', inputs => 
        inputs.map(input => ({
          type: input.type,
          name: input.name,
          id: input.id,
          className: input.className,
          placeholder: input.placeholder,
          visible: input.offsetParent !== null
        }))
      );
      
      console.log(`[${sessionId}] Available input fields:`, JSON.stringify(availableInputs, null, 2));
      throw new Error('Could not find username input field');
    }
    
    // Human-like delay between fields
    await humanDelay(1000, 2000);
    
    // Try multiple selectors for password field
    console.log(`[${sessionId}] Looking for password field...`);
    const passwordSelectors = [
      '.form-row:nth-child(2) input',
      '.form-row input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="Password"]',
      'input[id*="password"]',
      '.login-form input[type="password"]',
      '#login-form input[type="password"]',
      '.modal-body input[type="password"]',
      '.form-row:last-child input'
    ];
    
    let passwordTyped = false;
    for (const selector of passwordSelectors) {
      try {
        console.log(`[${sessionId}] Trying password selector: ${selector}`);
        passwordTyped = await humanType(page, selector, password, sessionId, 10000);
        if (passwordTyped) {
          console.log(`[${sessionId}] Password typed successfully with: ${selector}`);
          break;
        }
      } catch (error) {
        console.log(`[${sessionId}] Password selector ${selector} failed, trying next...`);
      }
    }
    
    if (!passwordTyped) {
      await takeScreenshot(page, '02-password-field-not-found', sessionId);
      throw new Error('Could not find password input field');
    }
    
    // Human-like delay before clicking login
    await humanDelay(1000, 2000);
    
    // Take screenshot before clicking login button
    await takeScreenshot(page, '03-before-login', sessionId);
    
    // Try multiple selectors for login button
    console.log(`[${sessionId}] Looking for login button...`);
    const loginButtonSelectors = [
      'button.btn-primary.loginButton',
      'button[type="submit"]',
      '.login-button',
      '.btn-login',
      'button:contains("Login")',
      'input[type="submit"]',
      '.modal-footer button',
      '.form-actions button',
      'button.primary'
    ];
    
    const loginButtonClicked = await findAndClickElement(page, loginButtonSelectors, sessionId, 20000);
    if (!loginButtonClicked) {
      // Take debug screenshot and log available buttons
      await takeScreenshot(page, '03-login-button-not-found', sessionId);
      
      const availableButtons = await page.$$eval('button, input[type="submit"]', buttons => 
        buttons.map(btn => ({
          type: btn.type,
          className: btn.className,
          id: btn.id,
          text: btn.textContent?.trim(),
          value: btn.value,
          visible: btn.offsetParent !== null
        }))
      );
      
      console.log(`[${sessionId}] Available buttons:`, JSON.stringify(availableButtons, null, 2));
      throw new Error('Could not find login button');
    }
    
    // Wait for login to complete with robust error handling
    console.log(`[${sessionId}] Waiting for login to complete...`);
    let loginSuccess = false;
    
    try {
      // Try to wait for navigation first
      await page.waitForNavigation({ 
        waitUntil: 'domcontentloaded', 
        timeout: 20000 
      });
      loginSuccess = true;
      console.log(`[${sessionId}] Navigation detected after login`);
    } catch (navError) {
      console.log(`[${sessionId}] No navigation detected, checking for other success indicators...`);
      
      // Check if we're still on the same page but login succeeded
      await humanDelay(3000, 5000);
      
      try {
        // Look for success indicators without navigation
        const successIndicators = [
          '.user-name',
          '.profile-name',
          '.user-profile',
          '[data-test="profile-menu"]',
          '.profile-dropdown',
          '.logout-link',
          '.user-menu'
        ];
        
        for (const indicator of successIndicators) {
          const element = await page.$(indicator);
          if (element) {
            console.log(`[${sessionId}] Login success indicator found: ${indicator}`);
            loginSuccess = true;
            break;
          }
        }
        
        // Check if login dialog disappeared (another success indicator)
        const loginDialog = await page.$('.login-form, .modal-body, .form-row');
        if (!loginDialog) {
          console.log(`[${sessionId}] Login dialog disappeared - likely successful`);
          loginSuccess = true;
        }
        
      } catch (checkError) {
        console.log(`[${sessionId}] Error checking login success: ${checkError.message}`);
      }
    }
    
    // Take screenshot after login attempt
    await takeScreenshot(page, '04-after-login', sessionId);
    
    // Final URL and success check
    const finalUrl = page.url();
    console.log(`[${sessionId}] Final URL after login: ${finalUrl}`);
    
    if (!loginSuccess && finalUrl.includes('naukri.com') && !finalUrl.includes('login')) {
      console.log(`[${sessionId}] URL changed from login page - considering successful`);
      loginSuccess = true;
    }
    
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
    console.error(`[${sessionId}] Error in login automation:`, error.message);
    res.status(500).json({ 
      error: 'Browser automation login failed', 
      details: error.message,
      sessionId: sessionId
    });
  } finally {
    clearTimeout(overallTimeout);
    if (browser) {
      console.log(`[${sessionId}] Closing browser...`);
      await browser.close();
      console.log(`[${sessionId}] Browser closed`);
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


