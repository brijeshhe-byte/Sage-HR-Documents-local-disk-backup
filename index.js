// ============================================
// SageHR Document Backup - Playwright Automation
// Full Backup + Incremental Backup Support
// Every file includes upload date+time in filename
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
  manifest.documents[doc.id] = {
    id: doc.id,
    file_name: doc.file_name,
    document_category_id: doc.document_category_id,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    file_size: doc.file_size,
    backed_up_at: new Date().toISOString(),
    local_path: savePath
  };
}

// ============================================
// FILENAME: Add upload date+time to every file
// Format: filename_YYYYMMDD-HHmmss.ext
// This guarantees unique filenames for every upload
// ============================================
function buildFileName(doc) {
  const originalName = doc.file_name || `document_${doc.id}`;
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);

  // Get upload date+time from Sage HR (created_at field)
  let dateTag = 'unknown';
  if (doc.created_at) {
    const d = new Date(doc.created_at);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    dateTag = `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  }

  return `${base}_${dateTag}${ext}`;
}

// ============================================
// CATEGORY CHANGE: Move file if category changed
// ============================================


function handleCategoryChange(manifest, doc, newSavePath) {
  const existing = manifest.documents[doc.id];
  if (!existing || !existing.local_path) return false;

  const oldPath = existing.local_path;

  // ✅ Compare ONLY directory (category), NOT filename
  const oldDir = path.normalize(path.dirname(oldPath));
  const newDir = path.normalize(path.dirname(newSavePath));

  // ✅ Same category → NOT a real category change
  if (oldDir === newDir) {
    return false;
  }

  if (!fs.existsSync(oldPath)) return false;

  console.log(`   [MOVE] Category changed for: ${path.basename(oldPath)}`);
  console.log(`          From: ${path.basename(oldDir)}`);
  console.log(`          To:   ${path.basename(newDir)}`);

  if (!fs.existsSync(newDir)) {
    fs.mkdirSync(newDir, { recursive: true });
  }

  try {
    fs.renameSync(oldPath, newSavePath);
    console.log(`   [OK] Moved successfully`);

    // cleanup empty old folder
    try {
      if (fs.readdirSync(oldDir).length === 0) {
        fs.rmdirSync(oldDir);
      }
    } catch {}

    return true;
  } catch (e) {
    console.log(`   [WARN] Could not move file: ${e.message}`);
    return false;
  }
}



// ============================================
// STEP 7: Clean filename (remove special chars)
// ============================================
function cleanFileName(name) {
  return name.replace(/[<>:"\/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// ============================================
// STEP 8: Download Document via Playwright
// Uses the download URL and saves with correct filename
// Handles empty files and download errors
// ============================================
async function downloadDocument(context, docId, savePath) {
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(savePath)) {
    console.log(`   [SKIP] Already exists: ${path.basename(savePath)}`);
    return 'skipped';
  }

  const page = await context.newPage();

  try {
    const downloadUrl = `${BASE_URL}/documents/${docId}/download`;

    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    page.goto(downloadUrl).catch(() => {});

    const download = await downloadPromise;
    await download.saveAs(savePath);

    const size = fs.statSync(savePath).size;
    if (size < 100) {
      fs.unlinkSync(savePath);
      console.log(`   [FAIL] Empty file: ${path.basename(savePath)}`);
      return 'failed';
    }

    console.log(
      `   [OK] Downloaded: ${path.basename(savePath)} (${(size / 1024).toFixed(1)} KB)`
    );
    return 'downloaded';

  } catch (e) {
    console.log(`   [FAIL] Download error: ${e.message}`);
    return 'failed';
  } finally {
    await page.close().catch(() => {});
  }
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

  const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
  await context.addCookies(cookies);

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
  let movedDocs = 0;

  // ---- Process Each Employee ----
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const empFolder = cleanFileName(`${emp.first_name}_${emp.last_name}_${emp.id}`);

    console.log(`\n[EMPLOYEE ${i + 1}/${employees.length}] ${emp.first_name} ${emp.last_name} (ID: ${emp.id})`);

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

    for (const doc of docs) {
      const categoryName = cleanFileName(categoryMap[doc.document_category_id] || 'Uncategorized');

      // Build filename with upload date+time (guarantees uniqueness)
      const fileName = cleanFileName(buildFileName(doc));
      let savePath = path.join(DOWNLOAD_DIR, empFolder, categoryName, fileName);

      // ---- CATEGORY CHANGE DETECTION ----
      const wasMoved = handleCategoryChange(manifest, doc, savePath);
      if (wasMoved) {
        movedDocs++;
        recordInManifest(manifest, doc, savePath);
        continue;
      }

      // ---- INCREMENTAL MODE CHECK ----
      if (isIncremental) {
        const status = needsDownload(manifest, doc);
        if (status === 'skip') {
          // Even if manifest says skip, check if file exists
          if (fs.existsSync(savePath)) {
            unchangedDocs++;
            continue;
          } else {
            console.log(`   [NEW] File missing at path: ${path.basename(savePath)}`);
          }
        }
        if (status === 'updated') {
          console.log(`   [UPDATED] ${path.basename(savePath)}`);
          // Old file stays with old timestamp, new file gets new timestamp
          // No renaming needed - timestamps make them unique!
        }
        if (status === 'new') {
          console.log(`   [NEW] ${path.basename(savePath)}`);
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

      await mainPage.waitForTimeout(500);
    }

    saveManifest(manifest);
    await mainPage.waitForTimeout(1000);
  }

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
    process.exit(0);
  });
} 
else if (args.includes('--check')) {
  isSessionValid().then(valid => {
    console.log(valid ? '[OK] Session is valid' : '[FAIL] Session expired');
    process.exit(0);
  });
} 
else {
  runBackup().catch(err => {
    console.error('[FAIL] Backup failed:', err.message);
    process.exit(1);
  });
}


