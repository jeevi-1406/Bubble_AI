const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const playwright = require('playwright-core');

const WebsiteRegistry = {
  youtube: {
    domain: 'youtube.com',
    url: 'https://www.youtube.com',
    selectors: {
      input: ['input#search', 'input[name="search_query"]', 'input[placeholder*="Search"]'],
      button: ['button#search-icon-legacy', 'button[aria-label="Search"]']
    },
    useEnter: true,
    directUrl: 'https://www.youtube.com/results?search_query='
  },
  linkedin: {
    domain: 'linkedin.com',
    url: 'https://www.linkedin.com',
    selectors: {
      input: ['input.search-global-typeahead__input', 'input[placeholder*="Search"]', 'input[aria-label*="Search"]'],
      button: []
    },
    useEnter: true,
    directUrl: 'https://www.linkedin.com/search/results/all/?keywords='
  },
  swiggy: {
    domain: 'swiggy.com',
    url: 'https://www.swiggy.com/search',
    selectors: {
      input: ['input.styles_searchBar__298Pt', 'input[placeholder*="Search"]', 'input[type="text"]'],
      button: []
    },
    useEnter: true,
    directUrl: 'https://www.swiggy.com/search?query='
  },
  amazon: {
    domain: 'amazon.in',
    url: 'https://www.amazon.in',
    selectors: {
      input: ['input#twotabsearchtextbox', 'input[name="field-keywords"]', 'input[placeholder*="Search"]'],
      button: ['input#nav-search-submit-button', 'input[type="submit"]']
    },
    useEnter: true,
    directUrl: 'https://www.amazon.in/s?k='
  },
  flipkart: {
    domain: 'flipkart.com',
    url: 'https://www.flipkart.com',
    selectors: {
      input: ['input[name="q"]', 'input[placeholder*="Search"]', 'input[title*="Search"]'],
      button: ['button[type="submit"]']
    },
    useEnter: true,
    directUrl: 'https://www.flipkart.com/search?q='
  },
  github: {
    domain: 'github.com',
    url: 'https://github.com',
    selectors: {
      input: ['button.header-search-button', 'input[name="q"]', 'input.header-search-input'],
      button: []
    },
    useEnter: true,
    directUrl: 'https://github.com/search?q='
  },
  reddit: {
    domain: 'reddit.com',
    url: 'https://www.reddit.com',
    selectors: {
      input: ['input#header-search-bar', 'input[name="q"]', 'input[placeholder*="Search"]'],
      button: []
    },
    useEnter: true,
    directUrl: 'https://www.reddit.com/search/?q='
  },
  stackoverflow: {
    domain: 'stackoverflow.com',
    url: 'https://stackoverflow.com',
    selectors: {
      input: ['input[name="q"]', 'input[placeholder*="Search"]'],
      button: []
    },
    useEnter: true,
    directUrl: 'https://stackoverflow.com/search?q='
  },
  netflix: {
    domain: 'netflix.com',
    url: 'https://www.netflix.com/search',
    selectors: {
      input: ['input[data-uia="search-box-input"]', 'input[placeholder*="Search"]', 'input[type="text"]'],
      button: []
    },
    useEnter: true,
    directUrl: 'https://www.netflix.com/search?q='
  },
  spotify: {
    domain: 'spotify.com',
    url: 'https://open.spotify.com/search',
    selectors: {
      input: ['input[data-testid="search-input"]', 'input[placeholder*="What do you want to listen to"]', 'input[type="text"]'],
      button: []
    },
    useEnter: true,
    directUrl: 'https://open.spotify.com/search/'
  }
};

class BrowserSearchService {
  constructor() {
    this.chromePath = null;
    this.findChromeExecutable();
  }

  findChromeExecutable() {
    // 1. Try common registry/process-env derived locations
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];

    if (process.env.LOCALAPPDATA) {
      paths.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    if (process.env.PROGRAMFILES) {
      paths.push(path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    if (process.env['PROGRAMFILES(X86)']) {
      paths.push(path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }

    for (const p of paths) {
      if (fs.existsSync(p)) {
        this.chromePath = p;
        console.log(`[Search Service] Chrome path found: ${p}`);
        return;
      }
    }

    // 2. Query Windows Registry for exact installation path if not found in common paths
    try {
      const regCmd = 'powershell.exe -Command "Get-ItemProperty -Path \'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\' -Name \'(default)\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty \'(default)\'"';
      const result = execSync(regCmd).toString().trim();
      if (result && fs.existsSync(result)) {
        this.chromePath = result;
        console.log(`[Search Service] Chrome registry path found: ${result}`);
        return;
      }
    } catch (e) {}

    try {
      const regCmdUser = 'powershell.exe -Command "Get-ItemProperty -Path \'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\' -Name \'(default)\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty \'(default)\'"';
      const resultUser = execSync(regCmdUser).toString().trim();
      if (resultUser && fs.existsSync(resultUser)) {
        this.chromePath = resultUser;
        console.log(`[Search Service] Chrome registry user path found: ${resultUser}`);
        return;
      }
    } catch (e) {}

    console.error("[Search Service] Warning: Chrome executable could not be located.");
  }

  // Check if Chrome CDP port is listening
  async isCDPAvailable() {
    return new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:9222/json/version', (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  // Send status messages back to clients over websocket
  sendStatus(ws, status) {
    console.log(`[Universal Search Status] ${status}`);
    if (ws && ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({
        type: 'browser_search_status',
        status: status
      }));
    }
  }

  // Match target site in our registry
  matchRegistry(siteName) {
    const name = siteName.toLowerCase().replace(/\s/g, '');
    for (const key of Object.keys(WebsiteRegistry)) {
      if (name.includes(key) || key.includes(name)) {
        return WebsiteRegistry[key];
      }
    }
    return null;
  }

  // Primary execution engine
  async executeSearch(siteName, query, ws = null) {
    this.sendStatus(ws, `Search command detected for site: ${siteName} | query: "${query}"`);
    
    // Auto-locate Chrome if path is invalid/null
    if (!this.chromePath || !fs.existsSync(this.chromePath)) {
      console.log("[Search Service] Chrome path invalid. Re-running executable locator...");
      this.findChromeExecutable();
    }

    try {
      const config = this.matchRegistry(siteName);
      let targetUrl = '';
      
      if (!config) {
        const cleanSite = siteName.trim().replace(/\s+/g, '').toLowerCase();
        if (cleanSite === 'google' || cleanSite === 'chrome') {
          targetUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          this.sendStatus(ws, `Detected Site: Google | Extracted Query: "${query}" | URL: ${targetUrl} | Type: Direct Google search`);
        } else {
          const domain = cleanSite.includes('.') ? cleanSite : `${cleanSite}.com`;
          targetUrl = `https://www.google.com/search?q=site:${domain}+${encodeURIComponent(query)}`;
          this.sendStatus(ws, `Detected Site: ${domain} (Unregistered) | Extracted Query: "${query}" | URL: ${targetUrl} | Type: Fallback Google search`);
        }
        return this.openDirectSearch(targetUrl, ws);
      }

      const directSearchUrl = `${config.directUrl}${encodeURIComponent(query)}`;

      // Check if CDP debugging is currently listening
      let isListening = await this.isCDPAvailable();
      if (!isListening) {
        this.sendStatus(ws, "Browser launch started (Starting Chrome with remote debugging)...");
        if (!this.chromePath || !fs.existsSync(this.chromePath)) {
          throw new Error(`Chrome executable not found at "${this.chromePath}". Please check Chrome installation.`);
        }

        // Start Chrome visible/headed with debugging enabled
        const startCmd = `Start-Process "${this.chromePath}" -ArgumentList "--remote-debugging-port=9222 --remote-allow-origins=* --start-maximized about:blank"`;
        const tempFile = path.join(__dirname, `temp_start_${Date.now()}.ps1`);
        fs.writeFileSync(tempFile, startCmd, 'utf8');
        await new Promise((resolve) => {
          exec(`powershell.exe -ExecutionPolicy Bypass -File "${tempFile}"`, () => {
            try { fs.unlinkSync(tempFile); } catch (e) {}
            resolve();
          });
        });

        // Wait up to 5 seconds for the debugging port to start listening
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          isListening = await this.isCDPAvailable();
          if (isListening) break;
        }

        if (!isListening) {
          throw new Error("Failed to start Chrome with remote debugging active.");
        }
        this.sendStatus(ws, "Browser launched successfully");
      } else {
        this.sendStatus(ws, "Browser launch started (Connecting to active browser)...");
        this.sendStatus(ws, "Browser launched successfully");
      }

      this.sendStatus(ws, `Detected Site: ${config.domain} | Extracted Query: "${query}" | URL: ${config.url} | Type: Direct in-page search`);
      this.sendStatus(ws, 'Connecting to browser...');
      
      const browser = await playwright.chromium.connectOverCDP('http://localhost:9222');
      const contexts = browser.contexts();
      const context = contexts[0];
      const pages = context.pages();

      let page = null;
      // Scan existing tabs for target domain
      for (const p of pages) {
        if (p.url().includes(config.domain)) {
          page = p;
          break;
        }
      }

      if (page) {
        this.sendStatus(ws, `Reusing active tab for ${config.domain}...`);
        await page.bringToFront();
        if (!page.url().includes(config.domain)) {
          await page.goto(config.url);
        }
      } else {
        this.sendStatus(ws, `Opening new tab and navigating to ${config.url}...`);
        page = await context.newPage();
        await page.goto(config.url);
      }

      // Maximize window via PowerShell helper (ensures active window gets focus)
      this.sendStatus(ws, 'Bringing browser to foreground...');
      await new Promise((resolve) => {
        const maximizeScript = `
          $code = @'
            using System;
            using System.Runtime.InteropServices;
            public class Win32 {
              [DllImport("user32.dll")]
              public static extern bool SetForegroundWindow(IntPtr hWnd);
              [DllImport("user32.dll")]
              public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            }
          '@
          Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
          $p = Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
          if ($p) {
            [Win32]::ShowWindow($p.MainWindowHandle, 3)
            [Win32]::SetForegroundWindow($p.MainWindowHandle)
          }
        `;
        const tempFile = path.join(__dirname, `temp_max_${Date.now()}.ps1`);
        fs.writeFileSync(tempFile, maximizeScript, 'utf8');
        exec(`powershell.exe -ExecutionPolicy Bypass -File "${tempFile}"`, () => {
          try { fs.unlinkSync(tempFile); } catch (e) {}
          resolve();
        });
      });
      this.sendStatus(ws, 'Browser brought to foreground');

      this.sendStatus(ws, 'Waiting for page interactivity...');
      await page.waitForLoadState('domcontentloaded');

      // Attempt to find search input using multiple fallbacks
      let searchInput = null;
      for (const selector of config.selectors.input) {
        try {
          searchInput = await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
          if (searchInput) {
            const tagName = await searchInput.evaluate(el => el.tagName.toLowerCase());
            if (tagName === 'button' || tagName === 'span') {
              console.log(`[Universal Search] Clicking search overlay trigger button: "${selector}"`);
              await searchInput.click();
              await new Promise(r => setTimeout(r, 600)); // wait for overlay animation
              const innerInput = await page.$('input[type="text"], input[type="search"], input[placeholder*="Search"]');
              if (innerInput) {
                searchInput = innerInput;
                break;
              }
            } else {
              break;
            }
          }
        } catch (e) {}
      }

      if (!searchInput) {
        this.sendStatus(ws, `Search box not found. Falling back to direct URL search...`);
        await page.goto(directSearchUrl);
        this.sendStatus(ws, 'Search executed');
        this.sendStatus(ws, 'Done');
        return true;
      }

      this.sendStatus(ws, 'Entering query...');
      await searchInput.click();
      
      // Clear current content
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');

      // Simulate human typing
      for (let i = 0; i < query.length; i++) {
        await page.keyboard.type(query[i], { delay: 60 + Math.random() * 50 });
      }

      this.sendStatus(ws, 'Submitting search...');
      let isSubmitted = false;
      if (config.selectors.button && config.selectors.button.length > 0) {
        for (const btnSel of config.selectors.button) {
          try {
            const btn = await page.$(btnSel);
            if (btn) {
              await btn.click();
              isSubmitted = true;
              break;
            }
          } catch (e) {}
        }
      }

      if (!isSubmitted || config.useEnter) {
        await page.keyboard.press('Enter');
      }

      this.sendStatus(ws, 'Search executed');
      this.sendStatus(ws, 'Done');
      return true;

    } catch (err) {
      console.error("[Universal Search] Search automation failed:", err);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Search automation failed: ${err.message}. Stack: ${err.stack}`
        }));
      }
      // Fallback
      const fallbackUrl = `https://www.google.com/search?q=site:${siteName.toLowerCase().replace(/\s/g, '')}.com+${encodeURIComponent(query)}`;
      return this.openDirectSearch(fallbackUrl, ws);
    }
  }

  // Direct open helper (used for fallbacks)
  async openDirectSearch(url, ws) {
    try {
      const isListening = await this.isCDPAvailable();
      if (!isListening) {
        const scriptContent = `
          $p = Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
          if ($p) {
            Start-Process '${this.chromePath}' -ArgumentList '${url}'
          } else {
            Start-Process '${this.chromePath}' -ArgumentList '--remote-debugging-port=9222 --remote-allow-origins=* --start-maximized "${url}"'
          }
        `;
        const tempFile = path.join(__dirname, `temp_run_${Date.now()}.ps1`);
        fs.writeFileSync(tempFile, scriptContent, 'utf8');
        await new Promise((resolve) => {
          exec(`powershell.exe -ExecutionPolicy Bypass -File "${tempFile}"`, () => {
            try { fs.unlinkSync(tempFile); } catch (e) {}
            resolve();
          });
        });
        this.sendStatus(ws, 'Done');
        return true;
      }

      const browser = await playwright.chromium.connectOverCDP('http://localhost:9222');
      const context = browser.contexts()[0];
      const page = await context.newPage();
      await page.goto(url);
      
      this.sendStatus(ws, 'Done');
      return true;
    } catch (e) {
      console.error("[Universal Search] Direct redirect fallback failed:", e);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'chrome_error',
          error: "Failed to execute fallback search: " + e.message
        }));
      }
      return false;
    }
  }

  // Test Chrome Launch (google.com)
  async testChrome(ws = null) {
    this.sendStatus(ws, "Testing Chrome launch...");
    if (!this.chromePath || !fs.existsSync(this.chromePath)) {
      this.findChromeExecutable();
    }
    
    if (!this.chromePath || !fs.existsSync(this.chromePath)) {
      throw new Error(`Chrome executable not found at path "${this.chromePath}"`);
    }

    this.sendStatus(ws, `Found Chrome executable at: ${this.chromePath}`);
    const testUrl = "https://www.google.com";
    const startCmd = `Start-Process "${this.chromePath}" -ArgumentList "${testUrl}"`;
    const tempFile = path.join(__dirname, `temp_test_${Date.now()}.ps1`);
    fs.writeFileSync(tempFile, startCmd, 'utf8');
    
    await new Promise((resolve, reject) => {
      exec(`powershell.exe -ExecutionPolicy Bypass -File "${tempFile}"`, (err) => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
        if (err) reject(err);
        else resolve();
      });
    });

    this.sendStatus(ws, "Test browser launched successfully");
    return true;
  }
}

module.exports = new BrowserSearchService();
