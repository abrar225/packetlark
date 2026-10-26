# PacketLark: signal into structure

Research and implementation: 24 October 2026. This document distinguishes observed reference patterns from PacketLark's original design choices. The reference sites were inspected in a live browser at approximately 948 × 871 CSS pixels; screenshots are research evidence, not redistributed assets. Desktop and mobile PacketLark layouts were checked separately.

## Reference research

### Emotion Agency — https://emotion-agency.com/

Observed: a full-screen entry with optional audio, an immersive lavender WebGL landscape, a large central particle glyph, oversized editorial typography anchored near the lower left, and a compact pill-shaped navigation overlay. Live computed styles identified **Emotion Serif** and **IBM Plex Mono**. The serif headlines and terse technical text produce strong contrast. Browser captures showed the entry gate and loaded hero; source inspection identified a Nuxt bundle. We did not establish the exact animation implementation from a screenshot or prove its full motion library inventory.

Transfer to PacketLark: one memorable central glyph, a controlled opening sequence, generous negative space, and one quiet navigation level. PacketLark uses a lightweight original SVG illustration instead of a landscape. There is no audio or loading gate before using the product.

### Chande Bootcamp — https://www.chandebootcamp.com/

Observed: large compressed display typography, modular image/text regions, a persistent navigation strip, cream paper surfaces, deep green, and a bright green accent. Live browser styles identified **Phudu** and **Geist Mono**, with a body background of `rgb(244, 243, 235)` / `#f4f3eb`. Firecrawl's branding extraction additionally reported `#68f12b`, `#236c3c`, and `#182220` (the last also appeared in page metadata). These extracted accent roles are approximate classifier output, not a complete set of authoritative CSS variables. The loaded browser capture confirmed the coarse modular composition and compressed headline treatment.

Transfer to PacketLark: deliberate changes in section density, a strong typographic silhouette, and surfaces that distinguish product explanation from product demonstration. We did not copy the site's portraits, logo, 3D work, textures, or exact grid.

Neither site's award status was independently verified. They are the user's supplied visual references. Mobile navigation, hover details, and the complete animation sequence of these reference sites were not comprehensively reverse engineered.

## PacketLark's proposed and implemented design system

Palette roles:

- **Ink — `#101016`**: workbench and homepage base; sustained focus.
- **Panel — `#181820`**: raised interface regions, with structural border `#33313f`.
- **Signal — `#bda9ff`**: primary actions, selected tabs, and the brand mark.
- **Paper — `#eeebf5`**: a light product explanation surface.
- **White — `#f4f1ff`**: main dark-surface text.
- **Muted — `#a7a3b8`**: supporting homepage copy; studio muted text is `#aaa7bc`.

Functional status colors are separate from branding: green `#8dd5b0`, amber `#e9c080`, and rose `#f594a4`. HTTP methods retain text labels; color is supplementary. Error and success copy explicitly identifies outcomes. Some inherited response rendering uses older inline semantic colors; this iteration does not claim a complete contrast certification.

Typeface roles:

- **Manrope Variable**: product headlines and wordmark, weight 550–750, compact headline tracking.
- **DM Sans Variable**: interface and prose, weight 400–650.
- **IBM Plex Mono**: actual code, URLs, methods, and terminal commands.

These fonts are installed through Fontsource and bundled locally. UI labels use the UI face rather than decorative monospace. Headline scale is approximately 65–112px depending on viewport; section headlines 36–64px. Workbench text is intentionally denser at 11–14px. Body paragraphs remain around 45–70 characters wide.

## Original identity

`public/brand/packetlark-symbol.svg` is the original PacketLark mark: a lark in flight, facing in the direction of a dispatched request. Two angular feather planes give it a clear silhouette. A diamond cutout represents a packet, with a small negative-space eye. The mark uses the existing Signal lavender without gradients, and the homepage hero repeats the same geometry. The favicon uses the same mark; an Ink variant serves light surfaces. `packetlark-wordmark.svg` provides a horizontal lockup. Keep the mark's aspect ratio and at least one packet-width of clear space. The full brand is always spelled **PacketLark**, with an uppercase P and L; the package, repository, CLI command and workspace directory use `packetlark`.

The identity is original vector construction. No external image or existing logo is embedded. Original construction does not constitute trademark clearance or a guarantee of uniqueness across all existing marks.

## Layout

Homepage: left-aligned editorial statement paired with the large signal glyph; one installation CTA; a truthful interactive sample in a light product section; a three-step capture workflow; an honest scope statement; installation commands; native expandable FAQ; concise footer. Desktop container is at most 1360px with 64px horizontal padding, dropping to 40px and then 22px. The mobile composition stacks the glyph below the primary copy. No horizontal page scrolling is intended.

Workbench: stable header, collection sidebar, breadcrumb, dispatch bar, request configuration, response inspection, local connection footer. At wider widths request and response sit side by side; below 1100px they stack. Below 760px collections become a toggleable overlay and dispatch controls wrap. Editors and responses retain native scrolling. The traffic screen has an explicit description of what is captured and its HTTPS CONNECT limit.

A screenshot is an observation of that viewport, not a guarantee across every browser and device. PacketLark is visually checked at 1440px, the browser's initial 948px viewport, and 390px, with an additional reduced-motion state.

## Motion contract

- **GSAP**: one coordinated hero intro; a restrained scroll-linked glyph shift and one product-window reveal.
- **Lenis**: homepage only, with native scrolling for nested code blocks. No scroll smoothing in the workbench.
- **Anime.js**: a short user-triggered sample response fade and 220ms response metric transition. Exact final values remain readable and are set when the animation completes.
- `prefers-reduced-motion` gates JS animations through `gsap.matchMedia()` and is also respected by CSS. Lenis is destroyed when the preference switches. Functional controls remain available with reduced motion or without decorative animation.
- No cursor replacement, perpetual logo pulse, hover text decryption, fabricated startup counters, or audio gate. Important workbench actions keep stable names.

Reference APIs: https://gsap.com/docs/v3/GSAP/gsap.matchMedia/ ; https://animejs.com/documentation/animation/ ; https://github.com/darkroomengineering/lenis

## Implementation and access

`public/index.html` and `public/landing.css` are the homepage; `public/studio.html`, `public/studio.css`, and `public/app.js` are the workbench. `web/` owns locally bundled font/icon/motion imports. `scripts/build-web.mjs` uses esbuild to emit `public/assets/` and creates a separate static `dist-site/` artifact for GitHub Pages.

Keyboard focus is visible. The homepage uses semantic landmarks and native details. Dialogs have names, focus containment, Escape dismissal, and return focus. Icon-only buttons receive accessible names. The studio has a skip link, collection search, Cmd/Ctrl+Enter to send, Cmd/Ctrl+S to save, Cmd/Ctrl+F for response search, and `/` to focus collection search. This is an accessibility improvement, not a complete WCAG audit.

The GitHub Pages deployment contains only the homepage and bundled assets; it neither runs the local backend nor accepts credentials. The sample response is explicitly labeled. Installation links use a project-relative path and work below `/packetlark/`.

## Acceptance and future refinements

Verify: desktop/mobile layout, no page overflow, sample switching, installation copy, request execution, persistence, independent request/response tab state, import dialogs, environment editing, traffic view, generated output escaping, focus behavior, reduced motion, and no third-party font/script requests.

The next product improvements should prioritize compatibility and capture correctness. More animation will not fix an incorrect request or inferred contract.
