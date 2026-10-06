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
| Fill current page | DOM observation and local rules fill supported controls, with independent verification and manual handling for unresolved fields |
| Task panel | One panel across frames; separate counts for automatic, assisted, preserved and skipped fields; stop at any time |
| Review queue | Recheck unconfirmed dates, locate dropdowns, confirm meanings or records, and supply missing facts |
| Region filling | A secondary entry uses the same protocol for a selected area; DOM observation only |
| Information panel | Focus a web form control and write one saved profile value at a time; rejected values are copied automatically |
| Resume library | Store role-specific resumes with independent parsed profiles and original filenames; profile source and attachment are selected independently |
| Resume parsing | Import PDF, DOCX, Markdown, TXT, and structured JSON resumes |
| Local backup | Versioned JSON import/export |

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
2. Select **资料设置** (Profile settings).
3. Complete personal information, education, work experience, projects, supplemental facts, and custom values on one continuous page. Use the in-page directory to jump to a section.
4. Click **保存全部资料** (Save all profile information) in the fixed footer. Data backup expands at the bottom of the page.

Add undergraduate and graduate education as separate records. Each record keeps its own school, college/department, major, major category/discipline, study mode, education level, academic degree, and dates. When a form explicitly says undergraduate or graduate, the matching record is selected instead of relying only on list order.
Missing colleges, study modes, degrees and date precision remain missing. Filling uses local DOM observations and rules. No model configuration is required. Unresolved meanings can be confirmed in the task panel or filled through the manual information assistant.

### 2. Import and confirm

Add a resume in **简历库**. The attachment is saved independently. Review the proposed profile changes and confirm selected items; replacements of existing facts are unchecked by default.

### 3. Fill a page

Select **填写当前页面** (Fill current page). The default source is your general profile; optional role-specific profiles appear under **更多**. Choose an attachment separately. The task panel observes the page, matches local rules, validates fact and record identities, executes supported controls and reads them back. Existing answers are preserved.

Handle outstanding items through recheck, locate, meaning/record confirmation, missing fact entry or skip. Saving a fact is independent of whether the page accepts it. Missing personal answers stay blank and are listed separately from failures. Use the optional personal-information form to save and fill, or save only. Saved age, portfolio URL, preferred cities, language skills and custom personal fields are reused across websites and edited in Personal Settings. Meaning corrections apply only to the current session. Manual actions are counted separately.

Each module is handled independently. Unsupported controls remain for manual review, and missing facts remain blank. No model requests or generated answers are used.

### 4. Other actions

**更多 → 只填某一区域** selects a region with the same decision protocol. Press `Esc` to cancel selection. **打开资料** opens the manual information assistant: focus a page control and click a saved value. The task panel offers safe undo and an explicit diagnostic export without profile values or full page HTML.

A navigation requires starting another session. The extension never submits applications.

### 5. Backup and restore

Open **数据备份** (Data backup):

- **导出完整数据** downloads a versioned JSON backup.
- **导入完整数据** validates a previous JSON backup before replacing local profile data.
- Existing backups from the earlier project version remain importable.

No manual changes to an old JSON file are required. New missing-information answers, site learning records,  are included when a new full backup is exported.

Model and WebDAV configuration in older backups is ignored. New backups exclude credentials. Retired model settings, caches, and WebDAV settings are removed from local storage when the extension starts.

Backups can contain personal information, resume files, and local settings. Store them securely.

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
- Manual backups are plain JSON and may contain sensitive profile data.
- Export a backup before uninstalling the extension or clearing extension data.

## License

MIT License
