# AI Rules & Tech Stack

## Tech Stack
- **Backend**: Node.js with Express framework for API routes and server-side logic.
- **Frontend**: Vanilla JavaScript (ES6+) with HTML5 and custom CSS3 (using CSS variables for theming).
- **State Management**: Client-side state managed via global variables and DOM manipulation in `public/index.html`.
- **Database**: Local JSON files (`data/*.json`) used as a lightweight document store for persistence.
- **Integrations**:
    - **PACTO**: Gym management system integration via Puppeteer (headless) and session-based scraping.
    - **Meta Ads**: Integration for fetching and managing marketing leads.
    - **WhatsApp (Uazapi)**: API integration for automated and manual messaging.
- **Authentication**: JWT-based authentication with secure cookies and `cookie-parser`.
- **Automation**: `node-cron` for background synchronization tasks and auto-sync flows.
- **Icons**: Lucide icons loaded via CDN in the frontend.

## Development Rules & Library Usage

### 1. Frontend Architecture
- **Single File Component**: Most of the frontend logic, styles, and HTML structure reside in `public/index.html`. 
- **Vanilla JS**: Do not introduce frontend frameworks (React/Vue) unless explicitly requested. Use modern ES6+ features.
- **Styling**: Use the established "Cosmic Dark" theme. Utilize the CSS variables defined in `:root` for colors, spacing, and radius to maintain visual consistency.

### 2. Backend Structure
- **Routes**: All API endpoints must be modularized in `src/routes/` and imported into `server.js`.
- **Integrations**: Logic for third-party services (PACTO, Meta, WhatsApp) must stay in `src/integrations/`.
- **Middleware**: Use `src/middleware/requireAuth.js` for any route that requires a logged-in session.

### 3. Data Management
- **Persistence**: Use the `data/` directory for JSON-based storage. Ensure file operations are handled safely to prevent corruption.
- **Caching**: Use `src/storage/cache.js` for temporary data that doesn't need full persistence.

### 4. External Libraries
- **Axios**: Use `axios` for all backend HTTP requests.
- **Puppeteer**: Use `puppeteer-extra` with the stealth plugin for PACTO headless integrations to avoid detection.
- **Lucide**: Use Lucide for all iconography. In the frontend, use `lucide.createIcons()` after DOM updates.
- **Multer**: Use `multer` for handling multipart/form-data (file uploads).

### 5. Coding Standards
- **Naming**: Use camelCase for variables and functions, PascalCase for classes/components, and snake_case for JSON keys where appropriate.
- **Error Handling**: Always wrap async operations in try-catch blocks and return meaningful error messages to the frontend.
- **Security**: Never expose API keys or credentials in the frontend. Use `process.env` on the backend.
