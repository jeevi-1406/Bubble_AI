const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class TerminalAutomationService {
  constructor() {
    this.activePid = null;
    this.shellType = null; // 'powershell' or 'cmd'
    this.cwd = process.cwd();
  }

  // Check if the current terminal process is still alive
  async isTerminalAlive() {
    if (!this.activePid) return false;
    return new Promise((resolve) => {
      exec(`tasklist /FI "PID eq ${this.activePid}"`, (err, stdout) => {
        if (err || !stdout) {
          resolve(false);
          return;
        }
        resolve(stdout.includes(this.activePid.toString()));
      });
    });
  }

  // Open PowerShell visibly
  async openPowerShell() {
    return this.openTerminal('powershell');
  }

  // Open CMD visibly
  async openCMD() {
    return this.openTerminal('cmd');
  }

  // Common launch routine
  async openTerminal(type = 'powershell') {
    const isAlive = await this.isTerminalAlive();
    if (isAlive && this.shellType === type) {
      console.log(`[Terminal Log] Reusing active ${type} terminal window (PID: ${this.activePid})`);
      await this.bringTerminalToFront();
      await this.maximizeTerminal();
      return this.activePid;
    }

    // Terminate any mismatching alive process first
    if (isAlive) {
      await this.closeTerminal();
    }

    const processName = type === 'powershell' ? 'powershell.exe' : 'cmd.exe';
    
    // Start-Process and capture its ID
    const launchCmd = `powershell.exe -Command "Start-Process ${processName} -PassThru | Select-Object -ExpandProperty Id"`;
    
    return new Promise((resolve, reject) => {
      exec(launchCmd, async (err, stdout) => {
        if (err) {
          console.error(`[Terminal Log] Failed to open ${type} terminal:`, err);
          reject(err);
          return;
        }

        const pid = parseInt(stdout.trim());
        if (isNaN(pid)) {
          reject(new Error("Failed to parse terminal PID"));
          return;
        }

        this.activePid = pid;
        this.shellType = type;
        console.log(`[Terminal Log] Opened new ${type} terminal window successfully (PID: ${pid})`);

        // Wait a brief moment for window handle creation
        setTimeout(async () => {
          await this.bringTerminalToFront();
          await this.maximizeTerminal();
          resolve(pid);
        }, 800);
      });
    });
  }

  // Bring the active terminal to the front
  async bringTerminalToFront() {
    if (!this.activePid) return;
    const script = this.getWin32AutomationScript(this.activePid, 1); // 1 = Normal/Restore
    return this.runPowerShellScript(script);
  }

  // Maximize the active terminal
  async maximizeTerminal() {
    if (!this.activePid) return;
    const script = this.getWin32AutomationScript(this.activePid, 3); // 3 = Maximize
    return this.runPowerShellScript(script);
  }

  // Close the active terminal window
  async closeTerminal() {
    if (!this.activePid) return;
    return new Promise((resolve) => {
      exec(`taskkill /PID ${this.activePid} /F`, () => {
        console.log(`[Terminal Log] Active terminal window closed (PID: ${this.activePid})`);
        this.activePid = null;
        this.shellType = null;
        resolve();
      });
    });
  }

  // Get current status summary
  async getTerminalStatus() {
    const isAlive = await this.isTerminalAlive();
    return {
      active: isAlive,
      pid: isAlive ? this.activePid : null,
      shell: isAlive ? this.shellType : null,
      cwd: this.cwd
    };
  }

  // Run a command inside the terminal window
  async runCommand(command) {
    // 1. Ensure terminal is open
    const shellToUse = this.shellType || 'powershell';
    await this.openTerminal(shellToUse);

    // 2. Track working directory updates locally (intercept "cd ")
    this.updateLocalCwd(command);

    // 3. Bring to front and Maximize
    await this.bringTerminalToFront();
    await this.maximizeTerminal();

    // 4. Send keys using PowerShell Win32/SendKeys script
    const escapedCmd = this.escapeSendKeys(command) + '{ENTER}';
    const script = this.getSendKeysScript(this.activePid, escapedCmd);

    return this.runPowerShellScript(script);
  }

  // Helper: Get Win32 ShowWindow and SetForegroundWindow script
  getWin32AutomationScript(pid, showCmd) {
    return `
[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
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
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p) {
  $hWnd = $p.MainWindowHandle
  if ($hWnd -ne [IntPtr]::Zero) {
    [Win32]::ShowWindow($hWnd, ${showCmd})
    [Win32]::SetForegroundWindow($hWnd)
  }
}
    `;
  }

  // Helper: Get SendKeys script
  getSendKeysScript(pid, escapedCmd) {
    return `
[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
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
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p) {
  $hWnd = $p.MainWindowHandle
  if ($hWnd -ne [IntPtr]::Zero) {
    [Win32]::ShowWindow($hWnd, 3)
    [Win32]::SetForegroundWindow($hWnd)
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('${escapedCmd.replace(/'/g, "''")}')
  }
}
    `;
  }

  // Helper: Run script file bypassing Execution Policy
  async runPowerShellScript(scriptContent) {
    const tempFile = path.join(__dirname, `temp_automation_${Date.now()}.ps1`);
    fs.writeFileSync(tempFile, scriptContent, 'utf8');

    return new Promise((resolve, reject) => {
      exec(`powershell.exe -ExecutionPolicy Bypass -File "${tempFile}"`, (err, stdout, stderr) => {
        // Clean up temp file safely
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {}

        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  // Escaping SendKeys special characters (+ ^ % ~ ( ) { } [ ])
  escapeSendKeys(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if ('+^%~(){}[]'.includes(char)) {
        result += `{${char}}`;
      } else {
        result += char;
      }
    }
    return result;
  }

  // Simple local directory tracker
  updateLocalCwd(command) {
    const trimmed = command.trim();
    if (trimmed.toLowerCase().startsWith('cd ')) {
      const target = trimmed.substring(3).trim().replace(/"/g, '').replace(/'/g, '');
      if (target === '..') {
        this.cwd = path.dirname(this.cwd);
      } else if (path.isAbsolute(target)) {
        this.cwd = target;
      } else {
        this.cwd = path.join(this.cwd, target);
      }
    }
  }

  // Command safety validation
  isCommandSafe(command) {
    const lower = command.toLowerCase().trim();
    
    // Dangerous patterns
    const dangerousPatterns = [
      /\bdel\b/, /\brm\b/, /\brmdir\b/, /\berase\b/, /\bremove-item\b/,
      /\bformat\b/,
      /\bshutdown\b/, /\brestart-computer\b/, /\breboot\b/, /\binit 0\b/,
      /\breg\b/, /\bregedit\b/,
      /\bnetsh\s+advfirewall\b/, /\bnetsh\s+firewall\b/, /\bset-netfirewall\b/,
      /\bsystem32\b/,
      /\bicacls\b/, /\btakeown\b/, /\bchmod\b/, /\bchown\b/
    ];

    const isUnsafe = dangerousPatterns.some(pattern => pattern.test(lower));
    return !isUnsafe;
  }

  // Discovers and launches application maximized
  async launchApplication(appName) {
    const name = appName.toLowerCase().trim();
    let execPath = '';

    if (name.includes('arduino')) {
      const paths = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Arduino IDE\\Arduino IDE.exe'),
        'C:\\Program Files\\Arduino IDE\\Arduino IDE.exe',
        'C:\\Program Files (x86)\\Arduino IDE\\Arduino IDE.exe',
        'C:\\Program Files\\Arduino\\arduino.exe'
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) {
          execPath = p;
          break;
        }
      }
      if (!execPath) execPath = 'arduino.exe'; // fallback to PATH
    } else if (name.includes('vscode') || name.includes('vs code') || name === 'code') {
      const paths = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Microsoft VS Code\\Code.exe'),
        'C:\\Program Files\\Microsoft VS Code\\Code.exe'
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) {
          execPath = p;
          break;
        }
      }
      if (!execPath) execPath = 'code.cmd'; // fallback to PATH
    } else if (name.includes('notepad')) {
      execPath = 'notepad.exe';
    } else if (name.includes('calculator') || name === 'calc') {
      execPath = 'calc.exe';
    } else {
      execPath = `${name}.exe`;
    }

    console.log(`[System Automation] Launching app: ${name} (Path/Command: ${execPath})`);

    const launchCmd = `powershell.exe -Command "Start-Process '${execPath}' -PassThru | Select-Object -ExpandProperty Id"`;

    return new Promise((resolve, reject) => {
      exec(launchCmd, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const pid = parseInt(stdout.trim());
        if (isNaN(pid)) {
          resolve(null);
          return;
        }

        // Wait for app window to draw, then maximize and focus
        setTimeout(async () => {
          try {
            const script = this.getWin32AutomationScript(pid, 3); // 3 = Maximize
            await this.runPowerShellScript(script);
            resolve(pid);
          } catch (e) {
            resolve(pid);
          }
        }, 1500);
      });
    });
  }

  // Opens File Explorer to a specific path
  async openExplorerPath(folderPath) {
    let target = folderPath.trim();
    if (!path.isAbsolute(target)) {
      target = path.join(this.cwd, target);
    }
    if (!fs.existsSync(target)) {
      target = 'C:\\'; // Fallback
    }

    console.log(`[System Automation] Opening explorer path: ${target}`);
    return new Promise((resolve, reject) => {
      exec(`explorer.exe "${target}"`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Searches files/folders in common user dirs and highlights the best match in Explorer
  async searchAndHighlightFile(targetName) {
    const cleanName = targetName.trim().replace(/['"^*?]/g, '');
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Drone_harjit';
    const searchDirs = [
      path.join(userProfile, 'Desktop'),
      path.join(userProfile, 'Downloads'),
      path.join(userProfile, 'Documents'),
      this.cwd
    ].filter(d => fs.existsSync(d));

    const escapedDirs = searchDirs.map(d => `'${d}'`).join(', ');

    // PowerShell search command (limit search depth to 2 to avoid freezes)
    const psFindCmd = `powershell.exe -Command "Get-ChildItem -Path ${escapedDirs} -Filter '*${cleanName}*' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"`;

    console.log(`[System Automation] Searching for file/folder: "${cleanName}"`);

    return new Promise((resolve, reject) => {
      exec(psFindCmd, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }

        const foundPath = stdout.trim();
        if (!foundPath) {
          reject(new Error(`Could not find any file or folder matching "${cleanName}".`));
          return;
        }

        console.log(`[System Automation] Found match: ${foundPath}. Opening explorer with select...`);
        exec(`explorer.exe /select,"${foundPath}"`, (e) => {
          if (e) reject(e);
          else resolve(foundPath);
        });
      });
    });
  }

  // Lists files on the desktop
  getDesktopFiles() {
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Drone_harjit';
    const desktopPath = path.join(userProfile, 'Desktop');
    if (!fs.existsSync(desktopPath)) {
      return [];
    }
    try {
      return fs.readdirSync(desktopPath).filter(f => !f.startsWith('desktop.ini'));
    } catch (e) {
      return [];
    }
  }

  // Gets titles of active GUI windows
  async getActiveWindowTitles() {
    const psCmd = `powershell.exe -Command "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty MainWindowTitle"`;
    return new Promise((resolve) => {
      exec(psCmd, (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const titles = stdout.split('\n')
          .map(t => t.trim())
          .filter(t => t.length > 0);
        resolve(titles);
      });
    });
  }
}

module.exports = new TerminalAutomationService();
