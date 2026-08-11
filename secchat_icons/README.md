# SecChat — Icon Package

Production icon assets for **SecChat**, the chat application in the SecRouter family. Derived from the SecRouter hexagon badge, with a speech tail and a three-dot conversation glyph.

---

## Geometry

The master mark is drawn on a **48 × 62** viewBox.

- **Badge + tail:** `M24 2 L44 13 L44 37 L28 50 L26 59 L20 49.5 L4 37 L4 13 Z`
  stroke-width `2`, `stroke-linejoin: round`, no fill.
- **Dots:** three circles, `r 2.9`, at `y 25`, `x 16 / 24 / 32`.
- **Accent:** the *center* dot only, in olive.
- **Solid silhouette** (small sizes): `M24 3 L43 13.5 L43 36.5 L28 49 L26 58 L20 48.5 L5 36.5 L5 13.5 Z`
- **Clearspace:** minimum padding on all sides = one dot diameter (5.8 units at master scale).

## Colors

| Token | Hex | Use |
|---|---|---|
| ink | `#17140d` | Mark on light backgrounds |
| olive | `#54672f` | Brand accent, app-icon background |
| olive-dark | `#232a16` | Dark app-icon background |
| olive-light | `#aebb78` | Accent dot on dark backgrounds |
| olive-pale | `#cdd6a6` | Accent dot on olive backgrounds |
| cream | `#f3f1e5` | Mark on dark backgrounds |
| sand | `#e7e3d7` | Light-alt tile background |

## Size behavior

The three dots collide below ~32px. Simplification is built into the exported files:

| Size | Treatment |
|---|---|
| 48px + | Full mark — outline badge, three dots, stroke 2–3.4 |
| 32px | Outline badge, **single center dot**, stroke 5 |
| 16px | **Solid silhouette**, no dots |

Stroke weight increases as size drops so the shape holds.

---

## Contents

### `marks/`
Bare marks, no background tile. Transparent.
- `secchat-mark-primary.svg` — ink + olive accent (light backgrounds)
- `secchat-mark-reversed.svg` — cream + olive-light accent (dark backgrounds)
- `secchat-mark-olive.svg` — single-color olive
- `secchat-mark-black.svg` / `secchat-mark-white.svg` — single-color, for print, embroidery, and one-color contexts
- `secchat-mark-solid.svg` — filled silhouette
- `png/` — 480px-wide PNGs of primary, reversed, and solid

### `app-icons/`
- `secchat-ios-1024.svg` — **primary app icon**, olive background, square corners (iOS applies its own mask)
- `secchat-ios-1024-dark.svg` — dark-olive variant for iOS dark/tinted icon slots
- `secchat-light-alt-1024.svg` — sand background, ink mark
- `secchat-android-adaptive-foreground.svg` + `secchat-android-adaptive-background.svg` — Android adaptive pair (432×432; foreground respects the 66% safe zone)
- `secchat-android-round-512.svg` — circular variant
- `secchat-maskable-512.svg` — PWA `maskable` icon (mark inset to survive aggressive cropping)
- `png/` — rasterized 1024, 512, 432, 192

### `favicon/`
- `favicon.svg` — scalable favicon (modern browsers)
- `favicon-32.svg`, `favicon-16.svg` — pre-simplified small sizes
- `favicon-mono.svg` — monochrome, for pinned tabs / high-contrast
- `apple-touch-icon-180.svg`
- `png/` — 180, 64, 48, 32, 16

### `ui-icons/`
Twelve interface icons matched to the brand: `chat`, `secure`, `route`, `lock`, `usage`, `audit`, `principal`, `redact`, `history`, `monitor`, `policy`, `send`.

**Spec:** 24 × 24 grid · stroke-width `1.8` · round cap and join · no fills · `stroke="currentColor"` so they inherit text color.

Recommended colors: `#17140d` default, `#54672f` active/selected, `#8a8a78` disabled.

---

## Implementation

### Web `<head>`
```html
<link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon/png/favicon-32.png" sizes="32x32">
<link rel="icon" href="/favicon/png/favicon-16.png" sizes="16x16">
<link rel="apple-touch-icon" href="/favicon/png/apple-touch-icon-180.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#54672f">
```

### `site.webmanifest`
```json
{
  "name": "SecChat",
  "short_name": "SecChat",
  "icons": [
    { "src": "/app-icons/png/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/app-icons/png/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/app-icons/png/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "theme_color": "#54672f",
  "background_color": "#ece8dc",
  "display": "standalone"
}
```

### iOS
Supply `secchat-ios-1024.png` as the App Store / asset-catalog icon. Do **not** pre-round the corners — iOS masks it. Use `secchat-ios-1024-dark.png` for the dark appearance slot.

### Android
Use the adaptive pair in `res/mipmap-anydpi-v26/`:
```xml
<adaptive-icon>
  <background android:drawable="@color/secchat_olive"/>   <!-- #54672f -->
  <foreground android:drawable="@drawable/ic_secchat_fg"/>
</adaptive-icon>
```

### UI icons in React
```jsx
import Chat from './ui-icons/chat.svg';
// stroke="currentColor" — set color via CSS
<Chat style={{ color: '#54672f' }} width={20} height={20} />
```

---

## Usage rules

- Never recolor the mark outside the palette above.
- Never rotate, skew, add gradients, drop shadows on the mark itself, or outline the dots.
- Keep clearspace of one dot diameter around the mark in all lockups.
- The center dot is the only accent — do not color all three.
- Below 32px, use the provided simplified files rather than scaling the full mark down.
- The mark sits alongside the SecRouter hexagon; keep both at matching optical size when shown together.

## Related

The SecRouter site and logo handoff lives in `design_handoff_secrouter_site/`. Full source designs: `SecChat Icon Set.dc.html`, `SecChat Icons.dc.html`, `SecRouter Logo.dc.html`.
