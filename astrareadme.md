# Astra Project Flow

## 1. Project Overview

This project is a patient investigation chart application.

The application is composed of:

- A React and Vite frontend
- A Node.js and Express backend
- External EMR web-service integration
- Optional MongoDB support through Docker Compose
- Nginx for production frontend serving
- Chart and report UI components for laboratory investigation data

The primary business flow is:

1. A user opens the frontend.
2. The user authenticates through the login screen.
3. The user enters a patient registration number and date range.
4. The frontend sends the search request to the backend.
5. The backend authenticates with or calls the external EMR service.
6. The backend retrieves and parses laboratory results.
7. Results are normalized and grouped by investigation.
8. The frontend renders charts, tables, reports, and detail views.

## 2. Repository Structure

### Root

- `package.json`
  - Workspace-level development, build, start, and Docker commands.
- `README.md`
  - Main setup and deployment documentation.
- `docker-compose.yml`
  - Development or base multi-container configuration.
- `docker-compose.prod.yml`
  - Production Compose overrides.
- `astrareadme.md`
  - This application-flow document.
- `client/`
  - React/Vite frontend.
- `server/`
  - Node.js/Express backend.
- `investigation-chart/`
  - Nested project tree or imported project copy. It must be treated separately until confirmed whether it is still required.

## 3. Frontend Flow

### Application Entry

The frontend is located under `client/`.

The expected startup command is:

```bash
npm run dev:client
```

The root equivalent is:

```bash
npm run dev
```

The frontend is built with:

```bash
npm run build
```

which delegates to the client package.

### Main UI

The main application component is:

- `client/src/App.jsx`

This component coordinates the application state and high-level screens. It is expected to manage:

- Login state
- Search state
- Loading and error states
- Retrieved investigation data
- Report and chart visibility
- Application-level settings

### Login

Login UI is implemented in:

- `client/src/components/LoginScreen.jsx`

The login flow is:

1. The user enters credentials.
2. The component submits credentials through the API client.
3. The backend validates or forwards the authentication request.
4. On success, the frontend stores the authenticated session state.
5. The application renders the investigation search interface.

Authentication state should be reviewed carefully to ensure credentials and tokens are not stored insecurely in browser storage.

### Search Form

Search UI is implemented in:

- `client/src/components/SearchForm.jsx`

The search form collects:

- Patient registration number
- Start date
- End date

The form validates user input and sends a search request through:

- `client/src/api/client.js`

The expected request shape is similar to:

```json
{
  "regNo": "4975109",
  "fromDate": "2025-01-01T00:00",
  "toDate": "2025-01-31T23:59"
}
```

### API Client

Frontend API access is centralized in:

- `client/src/api/client.js`

This module should contain the HTTP calls used for:

- Login
- Health checks
- Hospital configuration
- Laboratory search
- Investigation detail retrieval
- Other application settings

Keeping requests in this module prevents UI components from directly duplicating HTTP configuration.

### Investigation Chart

Chart rendering is implemented in:

- `client/src/components/InvestigationChart.jsx`

The expected chart flow is:

1. Receive normalized investigation records from `App.jsx`.
2. Group records by test or investigation category.
3. Convert result values and dates into chart-ready structures.
4. Render trends over time.
5. Display reference ranges, abnormal indicators, units, and result metadata where available.

### Supporting Components

The frontend also contains:

- `client/src/components/DischargeReports.jsx`
  - Displays discharge-related report data.
- `client/src/components/Icons.jsx`
  - Shared icon definitions or icon rendering helpers.
- `client/src/components/Pagination.jsx`
  - Handles paging through result records or report entries.
- `client/src/components/WatiSettings.jsx`
  - Provides WATI-related configuration or messaging settings.

### Styling

Main styles are located in:

- `client/src/styles/App.css`

The styling controls:

- Layout
- Search controls
- Result cards
- Charts
- Reports
- Responsive behavior
- Login and settings screens

## 4. Backend Flow

The backend is located under `server/`.

The expected development command is:

```bash
npm run dev:server
```

The expected production command is:

```bash
npm start
```

The backend exposes the API used by the frontend.

### Main API Areas

Documented API endpoints include:

- `GET /api/health`
  - Health check.
- `GET /api/config/hospital`
  - Returns hospital or letterhead configuration.
- `POST /api/search`
  - Searches laboratory results and prepares chart data.
- `GET /api/detail/:orderid`
  - Retrieves raw laboratory detail for an order.

Authentication endpoints may also be present in the server implementation.

### Search Request Flow

The search request follows this sequence:

1. Frontend submits registration number and date range.
2. Express receives `POST /api/search`.
3. Backend validates the request.
4. Backend calls the EMR service.
5. EMR response data is decoded or parsed.
6. Laboratory rows are normalized.
7. Results are grouped into investigation categories.
8. Backend returns JSON to the frontend.
9. Frontend renders tables, charts, and reports.

### Detail Request Flow

The detail flow is:

1. User selects a specific laboratory order.
2. Frontend requests `/api/detail/:orderid`.
3. Backend fetches raw or detailed EMR data.
4. Backend parses the response.
5. Frontend displays the detailed result.

## 5. External EMR Integration

The backend depends on an external EMR system for:

- Login
- Patient and registration lookup
- Laboratory search
- Laboratory detail retrieval
- Hospital configuration
- Investigation metadata

The integration requires environment configuration, likely including:

- EMR base URL
- Login URL
- Query or data-table URL
- Username
- Password
- Connection identifiers
- Hospital or database identifiers
- Server port

The example configuration should be checked in:

- `server/.env.example`

Do not commit real credentials, session tokens, or production API keys.

## 6. Data Processing

Laboratory data may arrive from the EMR as:

- JSON
- JSON embedded in a response property
- HTML
- Delimited or tabular data
- Raw report text

The backend processing pipeline should:

1. Validate the upstream response.
2. Extract the relevant payload.
3. Parse JSON or HTML safely.
4. Normalize field names.
5. Normalize dates and numeric values.
6. Preserve units and reference ranges.
7. Identify abnormal or flagged values.
8. Group results by test name or category.
9. Return a stable frontend response shape.

Potential parsing utilities include files under:

- `server/src/utils/`
- `server/src/services/`
- `server/src/templates/`

Any parser that processes external HTML or database-like response content should handle malformed and unexpected data without crashing the API process.

## 7. Configuration

Important configuration files include:

- `package.json`
- `client/package.json`
- `server/package.json`
- `client/vite.config.js`
- `client/nginx.conf`
- `docker-compose.yml`
- `docker-compose.prod.yml`
- `server/.env.example`

The frontend development server is expected to run on port `5173`.

The backend is expected to run on port `3001`, based on the project documentation.

The production frontend is expected to be served by Nginx, commonly on port `80` inside its container and mapped to a host port through Compose.

## 8. Local Development

Install dependencies:

```bash
npm run install:all
```

Run frontend and backend together:

```bash
npm run dev
```

Run only the frontend:

```bash
npm run dev:client
```

Run only the backend:

```bash
npm run dev:server
```

Build the frontend:

```bash
npm run build
```

Start the backend:

```bash
npm run start
```

Before starting the application:

1. Create `server/.env` from `server/.env.example`.
2. Add valid EMR configuration.
3. Install root, client, and server dependencies.
4. Confirm the EMR service is reachable.
5. Confirm the configured ports are available.

## 9. Docker Flow

Base commands:

```bash
npm run docker:up
npm run docker:down
npm run docker:logs
```

Production commands:

```bash
npm run docker:prod
npm run docker:prod:down
```

Docker startup requires:

- Docker Engine
- Docker Compose
- Valid environment configuration
- Required Dockerfiles
- Required frontend and backend package files

The current workspace check reported:

```text
env file .../server/.env not found
```

Therefore Docker startup is not currently reproducible until `/home/itmapims/KARTHI APPS/investigation-chart/server/.env` is created with valid values.

## 10. Testing and Validation

The root package does not currently expose a reliable `test` script.

Existing server test or manual files appear to include:

- Authentication checks
- Direct API calls
- EMR integration experiments
- Investigation group checks
- No-authentication experiments

Some manual scripts call live external EMR endpoints. They should not be treated as deterministic automated tests.

Recommended validation sequence:

```bash
npm install
npm run install:all
npm run build
```

Then validate:

- Backend health endpoint
- Login behavior
- Search with a known test registration number
- Detail lookup with a known order ID
- Empty result handling
- Invalid date handling
- EMR timeout handling
- Authentication failure handling
- Mobile layout
- Production Docker startup

## 11. Current Workspace Issues

The following issues were observed during project inspection:

- The Git branch has diverged from its remote branch.
- Several tracked files are modified or deleted.
- A nested `investigation-chart/` project exists inside the root project.
- `vite` was unavailable during the build attempt, indicating missing or incomplete client dependencies.
- The root package has no working test script.
- Docker could not find `server/.env`.
- Docker cleanup reported a Compose network still in use.
- Several files may contain sensitive or operational data and require review before committing.
- Manual integration scripts may call external EMR services directly.

These issues should be resolved or explicitly documented before deployment.

## 12. Security Checklist

Before production use:

- Keep `server/.env` out of version control.
- Remove real credentials from test scripts and documentation.
- Avoid logging passwords, tokens, raw patient data, or full EMR responses.
- Validate all user-provided registration numbers, dates, and order IDs.
- Use request timeouts for external EMR calls.
- Return generic errors to clients while logging safe diagnostic details server-side.
- Restrict CORS to approved frontend origins.
- Add authentication and authorization checks to every sensitive endpoint.
- Avoid exposing raw upstream HTML or database responses unnecessarily.
- Review patient-data retention and logging behavior.
- Confirm Nginx does not expose source files, environment files, or private artifacts.

## 13. Recommended Improvements

1. Decide whether the root project or nested `investigation-chart/` directory is authoritative.
2. Remove or archive the duplicate project tree after confirming its contents.
3. Add a deterministic automated test script.
4. Separate live EMR integration tests from unit tests.
5. Add mocked tests for search, parsing, authentication, and error handling.
6. Add request validation at every API boundary.
7. Add timeout and retry policy for EMR requests.
8. Add a documented response schema shared by frontend and backend.
9. Add CI checks for build, tests, formatting, and secret scanning.
10. Ensure Dockerfiles and ignore files are present and tracked.
11. Document all required environment variables.
12. Remove sensitive files such as credentials, patient exports, archives, and screenshots from the repository unless explicitly required.

## 14. End-to-End Summary

```text
Browser
  |
  v
React/Vite frontend
  |
  | login, search, detail, settings requests
  v
Express API
  |
  | validate input
  | authenticate or use configured EMR credentials
  | fetch EMR data
  | parse and normalize results
  v
External EMR service
  |
  v
Normalized investigation JSON
  |
  v
React state
  |
  +--> Investigation charts
  +--> Result tables
  +--> Discharge reports
  +--> Pagination
  +--> Detail views
  +--> WATI/settings UI
```

## 15. Source of Truth

This document describes the observed project structure and the intended application flow. It should be updated whenever any of the following change:

- API routes
- Authentication behavior
- EMR endpoints
- Response schemas
- Frontend navigation
- Docker services
- Environment variables
- Deployment ports
- Data-processing or charting behavior
