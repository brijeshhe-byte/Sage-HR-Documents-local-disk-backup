# SageHR Document Backup - Playwright Automation

Automated backup of all employee documents from [Sage HR](https://sage.hr) to local storage using Node.js and Playwright.

---

## Overview

Sage HR does not provide an API endpoint for downloading document files. The API only returns document **metadata** (name, size, category, etc.). Actual file downloads require a **browser session** with cookies, as the download endpoint (`/documents/{id}/download`) redirects to a pre-signed AWS S3 URL and is protected by Cloudflare.

This tool solves that problem by:
1. Using the **Sage HR API** to fetch employee and document metadata
2. Using **Playwright** (a real browser) to download actual document files
3. Organizing files into a clean folder structure: `Employee / Category / File`
4. Supporting **incremental backups** (only new or updated documents)
5. **Never deleting files** 
6. Detecting **category changes** and moving files (no duplicates)

---

## Features

- **Full Backup** — Downloads all documents for all employees
- **Incremental Backup** — Only downloads new or updated documents since last backup
- **Version History** — When a document is updated, old version is renamed `_v1`, `_v2`, etc. (never deleted)
- **Category Change Detection** — When a document's category changes, the file is moved (not duplicated)
- **Session Management** — Login once with 2FA, reuse session cookies for future runs
- **Pagination Support** — Handles employees and documents across multiple pages
- **Organized Storage** — Files saved as `Employee_Name / Category / filename.pdf`
- **Manifest Tracking** — Tracks every backed-up document with timestamps, versions, and metadata
- **Crash Recovery** — Manifest saved after each employee, so interrupted backups resume cleanly
- **Skip Existing** — Already-downloaded files are automatically skipped
- **Cloudflare Compatible** — Uses a visible browser to bypass Cloudflare bot protection
- **Hidden Browser** — Browser window runs off-screen (invisible to user, visible to Cloudflare)

---

## Prerequisites

- **Node.js** v18 or higher — [Download here](https://nodejs.org)
- **Sage HR Account** with admin/document access
- **Sage HR API Token** — Found in Sage HR > Settings > Integrations > API
- **Login Credentials** — Email + password + 2FA for initial browser login

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/sagehr-playwright-backup.git
cd sagehr-playwright-backup
```

### 2. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 3. Configure environment

```bash
cp .envSample .env
```

Edit `.env` with your actual values (see Configuration section below).

---

## Configuration

### `.env` file

Copy `.envSample` to `.env` and fill in your values:

```env
SAGEHR_BASE_URL=https://yourcompany.sage.hr
SAGEHR_EMAIL=your-email@company.com
SAGEHR_PASSWORD=your-password
SAGEHR_API_TOKEN=your_api_token_here
DOWNLOAD_DIR=./downloads
```

| Variable | Description | Example |
|----------|-------------|---------|
| `SAGEHR_BASE_URL` | Your Sage HR instance URL | `https://yourcompany.sage.hr` |
| `SAGEHR_EMAIL` | Login email (for reference) | `admin@company.com` |
| `SAGEHR_PASSWORD` | Login password (for reference) | `your-password` |
| `SAGEHR_API_TOKEN` | API token from Sage HR settings | `your_api_token_here` |
| `DOWNLOAD_DIR` | Where to save downloaded files | `./downloads` |

> **Note:** `SAGEHR_EMAIL` and `SAGEHR_PASSWORD` are stored for your reference only. The script does NOT auto-fill login — you type credentials manually in the browser.

> **Important:** Never commit your `.env` file. It contains sensitive credentials.

---

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `node index.js --login` | Open browser, login manually with 2FA, save session cookies |
| `node index.js --check` | Check if saved session is still valid |
| `node index.js` | Run **full backup** (download all documents) |
| `node index.js --incremental` | Run **incremental backup** (only new/updated documents) |

### First-Time Setup

```bash
# Step 1: Login and save session (browser opens, you login + 2FA)
node index.js --login

# Step 2: Run full backup
node index.js
```

### Ongoing Backups (Daily/Weekly)

```bash
# Check if session is still valid
node index.js --check

# If expired, re-login
node index.js --login

# Run incremental backup (only new/updated docs)
node index.js --incremental
```

---

## How It Works

### Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   Sage HR API     |     |   Sage HR Web     |     |   Amazon S3       |
|   (JSON metadata) |     |   (Browser login) |     |   (File storage)  |
+--------+----------+     +--------+----------+     +--------+----------+
         |                         |                          |
         v                         v                          v
  GET /api/employees       /documents/{id}/download    Pre-signed URL
  GET /api/documents         (302 redirect)            (actual file)
  GET /api/documents/          |                          |
      categories               +----------+---------------+
         |                                |
         v                                v
  +------+--------------------------------+------+
  |          Playwright (Node.js)                 |
  |  - Fetches metadata via API (X-Auth-Token)   |
  |  - Downloads files via browser (cookies)     |
  |  - Saves to local filesystem                 |
  |  - Versions old files (_v1, _v2)             |
  |  - Moves files on category change            |
  +----------------------------------------------+
```

### Step-by-Step Flow

1. **Session Check** — Loads saved cookies and verifies they work
2. **Login (if needed)** — Opens visible browser for manual login + 2FA
3. **Fetch Employees** — Calls `GET /api/employees` with API token (all pages)
4. **Fetch Categories** — Calls `GET /api/documents/categories` with API token
5. **For Each Employee:**
   - Calls `GET /api/documents?employee_id={id}` (handles pagination)
   - For each document:
     - Check if category changed — **move file** (no duplicate)
     - (Incremental mode) Check manifest — skip if unchanged
     - If updated — **rename old file** to `_v1`, `_v2` (never delete)
     - Open new browser tab — download — save to correct folder
     - Record in manifest
6. **Summary** — Prints download statistics

### Why Playwright (Not API)?

| Method | Metadata | File Download | Cloudflare |
|--------|----------|---------------|------------|
| Sage HR API (`X-Auth-Token`) | Yes | No (JSON only) | N/A |
| Fetch/Axios | No | No (403 blocked) | Blocked |
| Playwright (visible browser) | N/A | Yes | Bypassed |

The Sage HR API **does not support file downloads**. The `/documents/{id}/download` endpoint requires browser session cookies and is protected by Cloudflare. Playwright solves both issues by running a real Chrome browser.

---

## Document Version History

When a document is **updated or replaced** on Sage HR, the system **never deletes** the old file. Instead, it renames the old version and downloads the new one.

### How It Works

```
1st upload:  contract.pdf           (original)
2nd upload:  contract.pdf           (new version downloaded)
             contract_v1.pdf        (old version renamed)
3rd upload:  contract.pdf           (newest version downloaded)
             contract_v2.pdf        (previous version renamed)
             contract_v1.pdf        (oldest version kept)
```

### Example Folder

```
John_Doe_1234567/
  General/
    Employee_contract.pdf           <-- Current (latest)
    Employee_contract_v1.pdf        <-- Version 1 (original)
    Employee_contract_v2.pdf        <-- Version 2 (replaced)
    Confidential_Agreement.pdf      <-- Never changed, no versions
```

### Version Rules

| Scenario | What Happens | Old File |
|----------|-------------|----------|
| Document uploaded first time | Downloaded as `filename.pdf` | N/A |
| Document replaced/updated | Old renamed to `filename_v1.pdf`, new downloaded as `filename.pdf` | Kept as `_v1` |
| Document replaced again | Old `filename.pdf` renamed to `filename_v2.pdf`, new downloaded | All versions kept |
| Document never changed | No action | Stays as-is |

> **Key principle: Files are NEVER deleted from backup. Every version is preserved.**

---

## Category Change Detection

When a document's **category is changed** on Sage HR (e.g., moved from "Training" to "Certifications"), the system **moves** the file instead of creating a duplicate.

### How It Works

```
Before: John_Doe/Training/First_Aid.pdf
After:  John_Doe/Certifications/First_Aid.pdf   (moved)
        John_Doe/Training/                        (empty folder removed)
```

### Detection Logic

1. Script checks manifest for the document ID
2. If manifest shows a different `local_path` than the new calculated path
3. The file is **moved** from old category folder to new category folder
4. No duplicate is created
5. Empty old folders are cleaned up automatically

---

## Download Folder Structure

```
downloads/
+-- John_Doe_1234567/
|   +-- General/
|   |   +-- Employee_contract.pdf         <-- Current version
|   |   +-- Employee_contract_v1.pdf      <-- Old version (kept)
|   |   +-- Confidential_Agreement.pdf
|   +-- Training/
|   |   +-- First_Aid_2028.pdf
|   |   +-- WHMIS.pdf
|   +-- Policies/
|       +-- Health_Safety_Handbook.pdf
+-- Jane_Smith_2345678/
|   +-- General/
|       +-- Contract.pdf
+-- Bob_Wilson_3456789/
    +-- General/
    |   +-- Employment_Contract.pdf
    +-- Certifications/
        +-- First_Aid.pdf
```

---

## Project Files

| File | Description | Git Tracked? |
|------|-------------|--------------|
| `index.js` | Main automation script (no secrets) | Yes |
| `package.json` | Node.js project config | Yes |
| `README.md` | Documentation | Yes |
| `.envSample` | Template for .env (no secrets) | Yes |
| `.gitignore` | Git ignore rules | Yes |
| `.env` | API token + credentials | **No** (secret) |
| `session-cookies.json` | Saved browser session cookies | **No** (secret) |
| `backup-manifest.json` | Tracks all backed-up documents | **No** (contains employee data) |
| `downloads/` | Downloaded document files | **No** (large + confidential) |
| `node_modules/` | Installed packages | **No** |

---

## Manifest File

The `backup-manifest.json` file tracks every document that has been backed up:

```json
{
  "lastBackupDate": "2026-05-14T22:30:00.000Z",
  "documents": {
    "1234567": {
      "id": 1234567,
      "file_name": "Employee_contract.pdf",
      "document_category_id": 100,
      "created_at": "2026-05-07T16:35:21Z",
      "updated_at": "2026-05-07T16:35:21Z",
      "file_size": 14537631,
      "version": 1,
      "backed_up_at": "2026-05-13T22:25:00.000Z",
      "local_path": "downloads/John_Doe_1234567/General/Employee_contract.pdf"
    }
  }
}
```

Fields used for incremental detection:
- `updated_at` — Detects document replacement/update
- `file_size` — Backup check if updated_at is unavailable
- `version` — Tracks version number for `_v1`, `_v2` naming
- `local_path` — Detects category changes (path difference)
- `document_category_id` — Stores category for reference

---

## Scenario Handling

| # | Scenario | Full Backup | Incremental | Local Files |
|---|----------|-------------|-------------|-------------|
| 1 | New employee joins | Downloads all docs | Detects as [NEW] | New folder created |
| 2 | New document added | Downloads new doc | Detects as [NEW] | Added to folder |
| 3 | Document updated/replaced | Skips (exists) | Old renamed _v1, new downloaded | **All versions kept** |
| 4 | Employee exits/deleted | Files stay locally | Files stay locally | **Never deleted** |
| 5 | Document deleted from Sage HR | Files stay locally | Files stay locally | **Never deleted** |
| 6 | Local file deleted by you | Re-downloads | Skips (in manifest) | Run full backup to recover |
| 7 | Employee name changed | New folder created | New folder created | Old folder remains |
| 8 | Category changed | Was: duplicate | Now: file **moved** | **No duplicates** |
| 9 | Session expires mid-backup | Resume with --incremental | Resume with --incremental | Safe (manifest saved) |
| 10 | Script crashes | Resume with --incremental | Resume with --incremental | Safe (manifest saved) |
| 11 | API token expired | Update .env | Update .env | Files safe |
| 12 | Shared document | Saved per employee | Saved per employee | One copy per employee |

> **Key principle: Local backup files are NEVER deleted. The system only adds or renames.**

---

## Backup Summary Output

After each run, you will see:

```
========================================
          BACKUP COMPLETE
========================================

Summary:
   Employees processed: 79
   Total documents:     3514
   Downloaded:          15          <-- New files downloaded
   Skipped (exists):    0           <-- Files already on disk
   Unchanged:           3490        <-- No changes detected (incremental)
   Versioned (old kept):3           <-- Old versions renamed _v1, _v2
   Moved (cat change):  6           <-- Files moved to new category
   Failed:              0           <-- Errors
   Saved to:            C:\...\downloads
   Manifest:            C:\...\backup-manifest.json
```

---

## Recommended `.gitignore`

```
# Secrets
.env
session-cookies.json

# Sensitive data
backup-manifest.json

# Downloads (large + confidential)
downloads/

# Node modules
node_modules/
package-lock.json

# OS files
.DS_Store
Thumbs.db
Desktop.ini

# IDE
.vscode/
.idea/
*.swp
*.swo

# Logs
*.log
npm-debug.log*

# Playwright
test-results/
playwright-report/
```

---

## Troubleshooting

### Session expired

```
[FAIL] Session expired. Need to login again.
```

**Fix:** Run `node index.js --login` and complete login + 2FA in the browser.

---

### Cloudflare 403 error

```
[FAIL] Failed: document.pdf -- Status: 403
```

**Fix:** The browser must run in visible mode (`headless: false`). Do not change this setting. Cloudflare blocks headless browsers.

---

### Download timeout

```
[FAIL] Failed: document.pdf -- Timeout 120000ms exceeded
```

**Fix:** Large files may take longer. Increase the timeout in `downloadDocument()`:
```javascript
const downloadPromise = downloadPage.waitForEvent('download', { timeout: 300000 }); // 5 min
```

---

### API returns 404

```
[FAIL] Failed to fetch documents: Request failed with status code 404
```

**Fix:** Ensure the API endpoint uses `/api/employees` (no `/v1/`). Sage HR does not use version prefixes in their API URLs.

---

### Too many open tabs / memory issues

If the script runs out of memory with many employees, restart the script. The `--incremental` flag will automatically skip already-downloaded files.

---

### Files download but are 0 bytes or HTML

If downloaded files contain HTML instead of actual content, the session cookies have expired. Run:
```bash
node index.js --login
```

---

### Local file deleted accidentally

Run a full backup (not incremental) to re-download missing files:
```bash
node index.js
```

---

## Security Notes

- **Never commit `.env` or `session-cookies.json`** to version control
- API tokens and session cookies provide full access to your Sage HR account
- Store the `.env` file securely and limit access
- Session cookies expire after a few hours — they cannot be reused indefinitely
- Consider encrypting the `downloads/` folder if it contains sensitive HR documents
- The `backup-manifest.json` contains employee names and document names — treat as confidential
- The `index.js` file contains **no secrets** — it reads all sensitive data from `.env`

---

## API Endpoints Used

| Endpoint | Method | Auth | Returns |
|----------|--------|------|---------|
| `/api/employees?page={n}` | GET | `X-Auth-Token` | Employee list (JSON, paginated) |
| `/api/documents?employee_id={id}&page={n}` | GET | `X-Auth-Token` | Document metadata (JSON, paginated) |
| `/api/documents/categories` | GET | `X-Auth-Token` | Category list (JSON) |
| `/documents/{id}/download` | GET | Session cookie | 302 redirect to S3 file |

---

## Tech Stack

- **Node.js** (v18+) — Runtime
- **Playwright** — Browser automation (Chromium)
- **Axios** — HTTP client for API calls
- **dotenv** — Environment variable management
- **fs / path** — File system operations (built-in)

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## License

MIT License. See [LICENSE](LICENSE) for details.

This project is not affiliated with Sage HR.
