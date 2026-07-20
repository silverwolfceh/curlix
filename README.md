# Curlix

**Capture — Rebuild — Replay.** A self-hosted HTTP client and API workbench for modern development teams.

![Curlix](static/logo.png)

Send requests, manage environments, build requests from natural language via AI, and replay saved requests. Your data stays on your machine — no accounts, no cloud dependencies.

## Features

- **Multi-tab workspace** — open and manage multiple requests in parallel
- **Full HTTP method support** — GET, POST, PUT, PATCH, DELETE
- **Headers & Cookies** — collapsible editors per request
- **Environment variables** — `{{VAR}}` substitution across URL, headers, cookies, and body
- **Request history** — automatic logging of every request with full request/response details
- **Save & organize** — persist requests with names, tags, and AI prompts; export/import as JSON
- **AI Assist** — describe a request in plain English (or paste a curl command); AI fills the form automatically
- **Try with requests** — generate standalone Python `requests` scripts from any saved request
- **Multi-user support** — register accounts, sync data across browsers
- **Corporate-ready** — NTLM/Kerberos auth, HTTP proxy support, SSL verification toggle
- **Admin panel** — centralized configuration for AI APIs, proxy settings, user management
- **Dark & Light themes** — switch anytime, preference saved per browser
- **Mobile-friendly** — responsive design works on any device

## Quick Start

### Prerequisites

- Python 3.9+
- pip (Python package manager)

### Installation

```powershell
# Clone the repository
git clone https://github.com/yourusername/curlix.git
cd curlix

# Create virtual environment
python -m venv .venv

# Activate it
.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### Running the App

```powershell
# Make sure the virtual environment is activated
.venv\Scripts\activate

# Start the development server
.venv\Scripts\uvicorn.exe main:app --reload
```

Open **http://localhost:5555** in your browser.

Admin panel: **http://localhost:5555/admin**

### Default Admin Account

On first run, Curlix creates a default admin account:

| Field    | Value |
|----------|-------|
| Username | `admin` |
| Password | `admin` |

**⚠️ Change this password immediately** via the admin panel.

Forgot the password? Reset it:

```powershell
.venv\Scripts\python.exe reset_admin.py your_new_password
```

## Using Curlix

### Sending Your First Request

1. Open Curlix in your browser
2. Enter a URL in the request bar (e.g., `https://httpbin.org/get`)
3. Click **Send**
4. View the response in the panel below

### Using Environment Variables

1. Click the **Env** tab in the sidebar
2. Add key/value pairs (e.g., `BASE_URL` = `https://api.example.com`)
3. Reference them in requests using `{{BASE_URL}}`
4. Variables resolve automatically in URLs, headers, cookies, and body

### AI Assist

1. Switch to the **AI** tab in a request panel
2. Type a description like `"GET /users with header X-Auth-Token"` or paste a curl command
3. Click **Fill with AI**
4. Review and edit the auto-filled fields
5. Send when ready

### Saving Requests

1. After sending a request, click the **Save** button
2. Give it a name
3. Find it in the **Requests** sidebar tab for quick access

### Multi-User & Sync

1. Click **Register** in the top-right corner
2. Create an account with username and password
3. Your saved requests, history, and environment variables sync to the server
4. Log in from any browser — your data follows you

### Proxy & Corporate Auth

Access in **Settings** (⚙️ icon) or the **Settings** tab:

- **Proxy URL/User/Pass** — configure HTTP proxy for all requests
- **NT ID/Password** — Basic auth credentials
- Per-request checkboxes: **Use Proxy**, **Use NTLM**, **Use Kerberos**

## Export & Import

Share request collections with your team:

1. Open the **Import/Export** dialog (button in sidebar)
2. **Export** — downloads all saved requests as a JSON file
3. **Import** — upload a previously exported JSON file

## Admin Panel

Visit **http://localhost:5555/admin** (admin login required) to:

- Configure AI API settings (OpenAI-compatible endpoints)
- Manage users and permissions
- View system settings
- Manage saved requests, history, and environment variables

### AI Configuration

| Field | Description |
|-------|-------------|
| API Base URL | OpenAI-compatible endpoint (e.g., `https://api.openai.com/v1`) |
| API Key | Your API key (`sk-...`) |
| Model | Model name (e.g., `gpt-4o-mini`) |
| Call API | `responses` or `completions` endpoint |
| Response Style | `strict_json` (recommended), `compact`, or `detailed` |

Users can also override AI settings in their personal Settings tab.

## Data Storage

All data stored in a single SQLite database: **`curlix.db`**

| Table | Description |
|-------|-------------|
| `users` | User accounts and roles |
| `settings` | Application configuration |
| `saved_requests` | Saved API requests |
| `history` | Request history |
| `env_vars` | Environment variables (encrypted) |
| `collections` | Request collections |

## Deployment Options

### Local Development

Use the built-in SQLite database (no additional setup).

### Serverless / Vercel

Set these environment variables:

| Variable | Description |
|----------|-------------|
| `TURSO_URL` | Turso database URL |
| `TURSO_TOKEN` | Turso authentication token |

Curlix automatically switches to Turso (libSQL over HTTP) when these are set, enabling deployment on serverless platforms.

## Security Notes

- Environment variables are encrypted at rest using AES-GCM with PBKDF2 key derivation
- Passwords are hashed with secure algorithms
- SSL verification is disabled by default for corporate network compatibility (can be enabled per-request)
- Always change the default admin password on first login

## Development

### Project Structure

```
main.py              # Application entry point
app/                 # Backend package
  config.py          # App factory and initialization
  db.py              # Database operations
  auth.py            # Authentication logic
  proxy.py           # Request proxy endpoint
  llm.py             # AI assistant endpoint
  ...                # Feature modules
static/              # Frontend files
  index.html         # Main application
  admin.html         # Admin panel
  app.js             # Frontend logic
  style.css          # Styling
requirements.txt     # Python dependencies
```

### Running Tests

Curlix is verified through manual testing. Check these areas after changes:

1. Request sending (all methods)
2. Environment variable substitution
3. Login/logout flow
4. Data sync between local and server
5. Admin panel functionality

## License

Private / internal — Curlix is provided for internal use.

---

**Built for developers who value simplicity, privacy, and control.**