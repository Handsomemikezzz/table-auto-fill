# Job ApplyMate

<p align="center">
  <img src="public/icons/job-applymate-master.png" width="160" alt="Job ApplyMate mascot holding an OFFER sign">
</p>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong>
</p>

Job ApplyMate is a Chrome and Edge extension that keeps job-application information in one place and fills online application forms with your personal profile, education, work experience, projects, and resume.

## Highlights

| Feature | Description |
|---|---|
| Profile management | Store personal information, separate undergraduate/graduate education, work experience, projects, skills, certificates, and custom fields |
| Fill current page | Every automatic binding is decided by the configured model, checked against saved fact and option IDs, then independently verified |
| Task panel | One panel across frames; separate counts for automatic, assisted, preserved and skipped fields; stop at any time |
| Review queue | Recheck unconfirmed dates, locate dropdowns, confirm meanings or records, and supply missing facts |
| Region filling | A secondary entry uses the same protocol for a selected area; no vision model required |
| Information panel | Focus a web form control and write one saved profile value at a time; rejected values are copied automatically |
| Resume library | Store role-specific resumes with independent parsed profiles and original filenames; profile source and attachment are selected independently |
| Resume parsing | Import PDF, DOCX, Markdown, TXT, and structured JSON resumes |
| Backup and sync | Versioned JSON import/export and optional conflict-aware WebDAV synchronization |

## Install

### Install a release build

1. Open the repository's **Releases** page, or download [`release/job-applymate-extension.zip`](release/job-applymate-extension.zip) directly from the repository.
2. Download `job-applymate-extension.zip` from the latest release when one is available.
3. Extract the ZIP file. Browsers cannot load the ZIP directly.
4. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
5. Enable **Developer mode**.
6. Click **Load unpacked** and select the extracted folder.
7. Pin **Job ApplyMate** to the browser toolbar.

### Build from source

Requirements:

- Chrome or Edge 116+
- Node.js 20.19+ or 22.12+
- npm

```bash
npm ci
npm test
npm run build
```

Load the generated `dist/` directory as an unpacked extension. To create the release ZIP, run:

```bash
npm run package:extension
```

## Usage

### 1. Set up your profile

1. Click the extension icon.
2. Select **资料与模型设置** (Profile and model settings).
3. Enter your personal information, education, work experience, projects, and custom values.
4. Click **保存设置** (Save Settings).

Add undergraduate and graduate education as separate records. Each record keeps its own school, college/department, major, major category/discipline, study mode, education level, academic degree, and dates. When a form explicitly says undergraduate or graduate, the matching record is selected instead of relying only on list order.
Missing colleges, study modes, degrees and date precision remain missing. Automatic filling requires a configured model. Profile management, local parsing, the manual information assistant and backups remain available without a model.

### 2. Import and confirm

Add a resume in **简历库**. The attachment is saved independently. Review the proposed profile changes and confirm selected items; replacements of existing facts are unchecked by default.

### 3. Fill a page

Select **填写当前页面** (Fill current page). The default source is your general profile; optional role-specific profiles appear under **更多**. Choose an attachment separately. The task panel observes the page, requests model decisions, validates fact and record identities, executes supported controls and reads them back. Existing answers are preserved.

Handle outstanding items through recheck, locate, meaning/record confirmation, missing fact entry or skip. Saving a fact is independent of whether the page accepts it. Explicit semantic corrections are scoped to the website, form structure and profile/registry versions, and can be disabled or deleted in Settings. Manual actions are counted separately.

The configured model endpoint is the only endpoint used. A model failure never falls back to rule-based automatic writing. New sessions always obtain model decisions. The first implementation uses the existing LLM connector through a provider interface; Laya integration and comparative accuracy/latency measurements remain a later phase. Complex cascaders may require manual selection.

### 4. Other actions

**更多 → 只填某一区域** selects a region with the same decision protocol. Press `Esc` to cancel selection. **打开资料** opens the manual information assistant: focus a page control and click a saved value. The task panel offers safe undo and an explicit diagnostic export without profile values or full page HTML.

A navigation requires starting another session. The extension never submits applications.

### 7. Backup and restore

Open **数据与同步**:

- **导出完整数据** downloads a versioned JSON backup.
- **导入完整数据** validates a previous JSON backup before replacing local profile data.
- Existing backups from the earlier project version remain importable.

No manual changes to an old JSON file are required. New missing-information answers, site learning records, and AI recognition rules are included when a new full backup is exported.

The legacy WebDAV path is intentionally retained for backward compatibility:

```text
job-application-helper/
└── job-application-helper.json
```

Backups can contain personal information, resume files, AI configuration, and API keys. Store them securely.

## Development commands

```bash
npm test                 # Run automated tests
npm run build            # Type-check and build dist/
npm run lint             # Run static checks
npm run dev              # Start the Vite development server
npm run package:extension # Build the release ZIP
```

## Tech stack

- React 19
- TypeScript 6
- Vite 8
- Chrome Extension Manifest V3
- Ant Design 6
- PDF.js, Mammoth, and Marked

## Data and privacy

- Data is stored in `chrome.storage.local` by default.
- JSON imports are limited to 20 MiB.
- Manual backups and WebDAV backups are plain JSON and may contain sensitive profile data and AI API keys.
- Data is sent to WebDAV only after the user explicitly configures and enables synchronization.
- Export a backup before uninstalling the extension or clearing extension data.

## License

MIT License
