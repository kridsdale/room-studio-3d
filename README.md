# Room Studio 3D

Interactive Three.js WebGL 3D room planner built for a 5-sided room with Sims-style IKEA Buy Mode, live IKEA Renton WA (`#488`) inventory sync + runtime lookup, Eye-Level curvilinear fisheye/Panini shader, and a Gemini 4 AI Layout Planner.

## Key Features
- **5-Sided Room Architecture:** Accurate angled SW entry wall, North & East windows, SE reach-in closet bi-folds, entry door swing clearance, and zero z-fighting.
- **Live IKEA Renton, WA (`#488`) Catalog:** 310+ pre-synced items with live Renton prices, 8-digit SKUs, real product photos, and live stock badges, plus a runtime **Live Renton `#488`** lookup modal that fetches any store SKU directly in-browser.
- **Gemini 4 AI Layout Planner:** Supports **Gemini 4 Neon** (`gemini-4-neon`), **Gemini 4 Carbon** (`gemini-4-carbon`), and **Gemini 4 Hydrogen** (`gemini-4-hydrogen`) with configurable thinking effort (`Low`/`Medium`/`High`), an AES-GCM-256 encrypted cross-session BYOK key vault (never exported in `.json` plans), and an offline built-in spatial planner fallback.
- **Eye-Level Curvilinear Fisheye Lens:** Custom GLSL shader (Equidistant Fisheye, Architectural Panini, Stereographic, Rectilinear) up to 165° FOV with exact 3D click/drag unprojection.
- **Save & Load Persistence:** Dual `localStorage` + IndexedDB auto-save, unlimited named saved plans, and portable `.json` export/import/drag-and-drop.

## Commands
```bash
npm install
npm run sync-renton   # Refresh live IKEA Renton, WA (#488) catalog prices, SKUs & stock
npm run build         # Bundle single-file static app into dist/index.html
npm start             # Serve locally
```
