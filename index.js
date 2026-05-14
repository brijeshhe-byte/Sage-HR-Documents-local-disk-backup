// ============================================
// SageHR Document Backup - Playwright Automation
// Full Backup + Incremental Backup Support
// Version History + Category Change Detection
// ============================================

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ---- Config from .env ----
const BASE_URL = process.env.SAGEHR_BASE_URL;
const API_TOKEN = process.env.SAGEHR_API_TOKEN;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const COOKIES_FILE = './session-cookies.json';
const MANIFEST_FILE = './backup-manifest.json';

// ---- CLI Arguments ----
const args = process.argv.slice(2);

// ============================================
// STEP 1: Login & Save Session
// ============================================
async function loginAndSaveCookies() {
  console.log('\n[LOGIN] Opening browser for manual login...');
  console.log('[LOGIN] Please login with your email, password, and 2FA.\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/signin`);

  console.log('[WAIT] Waiting for you to complete login + 2FA...');
  console.log('       (Script will continue automatically after login)\n');

  try {
    await page.waitForURL('**/dashboard**', { timeout: 300000 });
    console.log('[OK] Login successful! Dashboard detected.\n');
  } catch (e) {
    const currentUrl = page.url();
    if (currentUrl.includes('/signin')) {
      console.log('[FAIL] Login was not completed within 5 minutes.');
      await browser.close();
      return false;
    }
    console.log(`[OK] Login detected! Current page: ${currentUrl}\n`);
  }

  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`[SAVE] Session cookies saved to ${COOKIES_FILE}`);
  console.log(`       (${cookies.length} cookies saved)\n`);

  await browser.close();
  console.log('[DONE] Browser closed. Session saved for future use.\n');
  return true;
}

// ============================================
// STEP 2: Check if Saved Session is Valid
// ============================================
async function isSessionValid() {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.log('[INFO] No saved session found.');
    return false;
  }

  console.log('[CHECK] Checking saved session...');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--window-position=-2400,-2400',
      '--window-size=1,1'
    ]
  });
  const context = await browser.newContext();

  const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
  await context.addCookies(cookies);

  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();

    if (currentUrl.includes('/signin')) {
      console.log('[FAIL] Session expired. Need to login again.\n');
      await browser.close();
      return false;
    }

    console.log('[OK] Session is still valid!\n');
    await browser.close();
    return true;
  } catch (e) {
    console.log('[FAIL] Session check failed:', e.message);
    await browser.close();
    return false;
  }
}

// ============================================
// STEP 3: Get Employees via API (with pagination)
// ============================================
async function getEmployees() {
  console.log('[API] Fetching employee list...');

  const allEmployees = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get(`${BASE_URL}/api/employees`, {
      headers: {
        'X-Auth-Token': API_TOKEN,
        'Accept': 'application/json'
      },
      params: {
        page: page
      }
    });

    const employees = response.data.data || [];
    allEmployees.push(...employees);

    console.log(`      Page ${page}: ${employees.length} employees`);

    const meta = response.data.meta;
    if (meta && meta.next_page) {
      page = meta.next_page;
    } else {
      hasMore = false;
    }
  }

  console.log(`      Total: ${allEmployees.length} employees.\n`);
  return allEmployees;
}

// ============================================
// STEP 4: Get Documents for an Employee via API
// ============================================
async function getEmployeeDocuments(employeeId) {
  const allDocs = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await axios.get(`${BASE_URL}/api/documents`, {
      headers: {
        'X-Auth-Token': API_TOKEN,
        'Accept': 'application/json'
      },
      params: {
        employee_id: employeeId,
        page: page
      }
    });

    const docs = response.data.data || [];
    allDocs.push(...docs);

    const meta = response.data.meta;
    if (meta && meta.next_page) {
      page = meta.next_page;
    } else {
      hasMore = false;
    }
  }

  return allDocs;
}

// ============================================
// STEP 5: Get Document Categories via API
// ============================================
async function getDocumentCategories() {
  console.log('[API] Fetching document categories...');

  const response = await axios.get(`${BASE_URL}/api/documents/categories`, {
    headers: {
      'X-Auth-Token': API_TOKEN,
      'Accept': 'application/json'
    }
  });

  const categories = response.data.data || [];
  const categoryMap = {};
  categories.forEach(cat => {
    categoryMap[cat.id] = cat.name || `Category_${cat.id}`;
  });

  console.log(`      Found ${categories.length} categories.\n`);
  return categoryMap;
}

// ============================================
// MANIFEST: Track Backed Up Documents
// ============================================
function loadManifest() {
  if (fs.existsSync(MANIFEST_FILE)) {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  }
  return { lastBackupDate: null, documents: {} };
}

function saveManifest(manifest) {
  manifest.lastBackupDate = new Date().toISOString();
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

function needsDownload(manifest, doc) {
  const existing = manifest.documents[doc.id];

  if (!existing) {
    return 'new';
  }

  if (doc.updated_at && existing.updated_at !== doc.updated_at) {
    return 'updated';
  }

  if (doc.file_size && existing.file_size !== doc.file_size) {
    return 'updated';
  }

  return 'skip';
}

function recordInManifest(manifest, doc, savePath) {
  const existing = manifest.documents[doc.id];
  const currentVersion = (existing && existing.version) ? existing.version + 1 : 1;

  manifest.documents[doc.id] = {
    id: doc.id,
    file_name: doc.file_name,
    document_category_id: doc.document_category_id,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    file_size: doc.file_size,
    version: currentVersion,
    backed_up_at: new Date().toISOString(),
    local_path: savePath
  };
}

// ============================================
// VERSION: Rename old file with version number
// (Never delete - keep _v1, _v2, etc.)
// ============================================
function versionOldFile(manifest, docId, currentSavePath) {
  const existing = manifest.documents[docId];
  if (!existing || !existing.local_path) return;

  const oldPath = existing.local_path;

  // Check if old file exists on disk
  if (!fs.existsSync(oldPath)) return;

  // Build versioned filename
  // e.g., contract.pdf -> contract_v1.pdf
  const version = existing.version || 1;
  const ext = path.extname(oldPath);
  const base = path.basename(oldPath, ext);
  const dir = path.dirname(oldPath);
  const versionedName = `${base}_v${version}${ext}`;
  const versionedPath = path.join(dir, versionedName);

  // Rename old file to versioned name
  try {
    fs.renameSync(oldPath, versionedPath);
    console.log(`   [VERSION] Kept old version: ${versionedName}`);
  } catch (e) {
    console.log(`   [WARN] Could not version old file: ${e.message}`);
  }
}

// ============================================
// CATEGORY CHANGE: Move file if category changed
// (Avoid duplicates across category folders)
// ============================================
function handleCategoryChange(manifest, doc, newSavePath) {
  const existing = manifest.documents[doc.id];
  if (!existing || !existing.local_path) return false;

  const oldPath = existing.local_path;
  const normalizedOld = path.normalize(oldPath);
  const normalizedNew = path.normalize(newSavePath);

  // Check if the path is different (category changed)
  if (normalizedOld === normalizedNew) return false;

  // Check if old file exists
  if (!fs.existsSync(oldPath)) return false;

  // File is in a different folder = category changed
  console.log(`   [MOVE] Category changed for: ${path.basename(oldPath)}`);
  console.log(`          From: ${path.dirname(oldPath).split(path.sep).slice(-1)}`);
  console.log(`          To:   ${path.dirname(newSavePath).split(path.sep).slice(-1)}`);

  // Create new directory if needed
  const newDir = path.dirname(newSavePath);
  if (!fs.existsSync(newDir)) {
    fs.mkdirSync(newDir, { recursive: true });
  }

  // Move file to new category folder
  try {
    fs.renameSync(oldPath, newSavePath);
    console.log(`   [OK] Moved successfully`);

    // Clean up empty old directory
    const oldDir = path.dirname(oldPath);
    try {
      const remaining = fs.readdirSync(oldDir);
      if (remaining.length === 0) {
        fs.rmdirSync(oldDir);
      }
    } catch (e) { /* ignore cleanup errors */ }

    return true; // File moved, no download needed
  } catch (e) {
    console.log(`   [WARN] Could not move file: ${e.message}`);
    return false;
  }
}

// ============================================
// STEP 6: Download Document via Browser
// ============================================
async function downloadDocument(context, docId, savePath) {
  // Create directory if it doesn't exist
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Skip if file already exists
  if (fs.existsSync(savePath)) {
    console.log(`   [SKIP] Already exists: ${path.basename(savePath)}`);
    return 'skipped';
  }

  const downloadPage = await context.newPage();

  try {
    const downloadUrl = `${BASE_URL}/documents/${docId}/download`;

    // Listen for the download event FIRST
    const downloadPromise = downloadPage.waitForEvent('download', { timeout: 120000 });

    // Navigate - this WILL throw "Download is starting" - that is OK!
    downloadPage.goto(downloadUrl, { timeout: 120000 }).catch(() => {});

    // Wait for download to actually start
    const download = await downloadPromise;

    // Save the file to our target path
    await download.saveAs(savePath);

    // Verify file was saved and has content
    if (fs.existsSync(savePath)) {
      const fileSize = fs.statSync(savePath).size;

      if (fileSize < 100) {
        fs.unlinkSync(savePath);
        console.log(`   [FAIL] Failed (empty): ${path.basename(savePath)}`);
        return 'failed';
      }

      console.log(`   [OK] Downloaded: ${path.basename(savePath)} (${(fileSize / 1024).toFixed(1)} KB)`);
      return 'downloaded';
    } else {
      console.log(`   [FAIL] Failed (not saved): ${path.basename(savePath)}`);
      return 'failed';
    }

  } catch (e) {
    console.log(`   [FAIL] Failed: ${path.basename(savePath)} -- ${e.message}`);
    return 'failed';
  } finally {
    await downloadPage.close().catch(() => {});
  }
}

// ============================================
// STEP 7: Clean filename (remove special chars)
// ============================================
function cleanFileName(name) {
  return name.replace(/[<>:"\/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// ============================================
// MAIN: Run the Full Backup
// ============================================
async function runBackup() {
  console.log('========================================');
  console.log('   SageHR Document Backup - Playwright  ');
  console.log('========================================\n');

  // ---- Check/Create Session ----
  let sessionOk = await isSessionValid();
  if (!sessionOk) {
    const loggedIn = await loginAndSaveCookies();
    if (!loggedIn) {
      console.log('[FAIL] Cannot proceed without login. Exiting.');
      return;
    }
  }

  // ---- Fetch Metadata via API ----
  const employees = await getEmployees();
  const categoryMap = await getDocumentCategories();

  // ---- Open VISIBLE Browser with Saved Session ----
  console.log('[BROWSER] Opening browser with saved session...\n');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-position=-2400,-2400',
      '--window-size=1,1'
    ]
  });

  const context = await browser.newContext({
    acceptDownloads: true
  });

  // Load cookies
  const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
  await context.addCookies(cookies);

  // Navigate to dashboard first (activate Cloudflare session)
  const mainPage = await context.newPage();
  await mainPage.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await mainPage.waitForTimeout(3000);
  console.log('[OK] Browser session activated.\n');

  // ---- Load Manifest ----
  const isIncremental = args.includes('--incremental');
  const manifest = loadManifest();

  if (isIncremental && manifest.lastBackupDate) {
    console.log(`[MODE] Incremental mode: Only downloading changes since ${manifest.lastBackupDate}\n`);
  } else {
    console.log(`[MODE] Full backup mode: Downloading all documents\n`);
  }

  // ---- Stats ----
  let totalDocs = 0;
  let downloadedDocs = 0;
  let skippedDocs = 0;
  let unchangedDocs = 0;
  let failedDocs = 0;
  let versionedDocs = 0;
  let movedDocs = 0;

  // ---- Process Each Employee ----
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const empFolder = cleanFileName(`${emp.first_name}_${emp.last_name}_${emp.id}`);

    console.log(`\n[EMPLOYEE ${i + 1}/${employees.length}] ${emp.first_name} ${emp.last_name} (ID: ${emp.id})`);

    // Get documents for this employee
    let docs;
    try {
      docs = await getEmployeeDocuments(emp.id);
    } catch (e) {
      console.log(`   [FAIL] Failed to fetch documents: ${e.message}`);
      continue;
    }

    console.log(`   [DOCS] ${docs.length} documents found`);

    if (docs.length === 0) {
      console.log('   [SKIP] No documents. Skipping.');
      continue;
    }

    totalDocs += docs.length;

    // Download each document
    for (const doc of docs) {
      const categoryName = cleanFileName(categoryMap[doc.document_category_id] || 'Uncategorized');
      const fileName = cleanFileName(doc.file_name || `document_${doc.id}`);
      const savePath = path.join(DOWNLOAD_DIR, empFolder, categoryName, fileName);

      // ---- CATEGORY CHANGE DETECTION ----
      // Check if this document was previously in a different category
      const wasMoved = handleCategoryChange(manifest, doc, savePath);
      if (wasMoved) {
        movedDocs++;
        recordInManifest(manifest, doc, savePath);
        continue; // File moved successfully, no download needed
      }

      // ---- INCREMENTAL MODE CHECK ----
      if (isIncremental) {
        const status = needsDownload(manifest, doc);
        if (status === 'skip') {
          unchangedDocs++;
          continue;
        }
        if (status === 'updated') {
          console.log(`   [UPDATED] ${fileName}`);
          // VERSION: Rename old file to _v1, _v2 etc. (NEVER delete)
          versionOldFile(manifest, doc.id, savePath);
          versionedDocs++;
        }
        if (status === 'new') {
          console.log(`   [NEW] ${fileName}`);
        }
      }

      const result = await downloadDocument(context, doc.id, savePath);
      if (result === 'downloaded') {
        downloadedDocs++;
        recordInManifest(manifest, doc, savePath);
      } else if (result === 'skipped') {
        skippedDocs++;
        recordInManifest(manifest, doc, savePath);
      } else {
        failedDocs++;
      }

      // Small delay to avoid rate limiting
      await mainPage.waitForTimeout(500);
    }

    // Save manifest after each employee (in case of crash)
    saveManifest(manifest);

    // Delay between employees
    await mainPage.waitForTimeout(1000);
  }

  // Final manifest save
  saveManifest(manifest);

  // ---- Summary ----
  console.log('\n========================================');
  console.log('          BACKUP COMPLETE               ');
  console.log('========================================');
  console.log(`\nSummary:`);
  console.log(`   Employees processed: ${employees.length}`);
  console.log(`   Total documents:     ${totalDocs}`);
  console.log(`   Downloaded:          ${downloadedDocs}`);
  console.log(`   Skipped (exists):    ${skippedDocs}`);
  console.log(`   Unchanged:           ${unchangedDocs}`);
  console.log(`   Versioned (old kept):${versionedDocs}`);
  console.log(`   Moved (cat change):  ${movedDocs}`);
  console.log(`   Failed:              ${failedDocs}`);
  console.log(`   Saved to:            ${path.resolve(DOWNLOAD_DIR)}`);
  console.log(`   Manifest:            ${path.resolve(MANIFEST_FILE)}\n`);

  await browser.close();
}

// ============================================
// CLI: Handle command-line arguments
// ============================================
if (args.includes('--login')) {
  loginAndSaveCookies().then(() => {
    console.log('Done! You can now run: node index.js');
  });
} else if (args.includes('--check')) {
  isSessionValid().then(valid => {
    console.log(valid ? '[OK] Session is valid' : '[FAIL] Session expired');
  });
} else {
  runBackup().catch(err => {
    console.error('[FAIL] Backup failed:', err.message);
  });
}
