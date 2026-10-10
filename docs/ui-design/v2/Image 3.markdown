---
name: AuraBrief
colors:
  surface: '#0f131c'
  surface-dim: '#0f131c'
  surface-bright: '#353942'
  surface-container-lowest: '#0a0e16'
  surface-container-low: '#181c24'
  surface-container: '#1c2028'
  surface-container-high: '#262a33'
  surface-container-highest: '#31353e'
  on-surface: '#dfe2ee'
  on-surface-variant: '#d8c3ad'
  inverse-surface: '#dfe2ee'
  inverse-on-surface: '#2c3039'
  outline: '#a08e7a'
  outline-variant: '#534434'
  surface-tint: '#ffb95f'
  primary: '#ffc174'
  on-primary: '#472a00'
  primary-container: '#f59e0b'
  on-primary-container: '#613b00'
  inverse-primary: '#855300'
  secondary: '#7bd0ff'
  on-secondary: '#00354a'
  secondary-container: '#00a6e0'
  on-secondary-container: '#00374d'
  tertiary: '#c5c9ff'
  on-tertiary: '#131e8c'
  tertiary-container: '#a3abff'
  on-tertiary-container: '#2c36a0'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffddb8'
  primary-fixed-dim: '#ffb95f'
  on-primary-fixed: '#2a1700'
  on-primary-fixed-variant: '#653e00'
  secondary-fixed: '#c4e7ff'
  secondary-fixed-dim: '#7bd0ff'
  on-secondary-fixed: '#001e2c'
  on-secondary-fixed-variant: '#004c69'
  tertiary-fixed: '#e0e0ff'
  tertiary-fixed-dim: '#bdc2ff'
  on-tertiary-fixed: '#000767'
  on-tertiary-fixed-variant: '#2f3aa3'
  background: '#0f131c'
  on-background: '#dfe2ee'
  surface-variant: '#31353e'
typography:
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.03em
  display-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-lg:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.04em
  label-md:
    fontFamily: Space Grotesk
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.06em
  label-sm:
    fontFamily: Space Grotesk
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 14px
    letterSpacing: 0.08em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-md: 1.5rem
  gutter-lg: 2rem
  margin: 1rem
  margin-md: 2rem
  margin-lg: 3rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

This design system is tailored for an intimate, voice-first morning intelligence experience. It balances the quiet calm of early hours with the razor-sharp clarity of modern audio computing. The interface caters to busy professionals, commuters, and audio-first information consumers who need high-signal news briefings delivered through customizable AI personas while multitasking.

The aesthetic fuses **Tactile Glassmorphism** with **Deep Nocturnal Minimalism**. Translucent obsidian planes float above dark voids, layered with precise rim-lighting and glowing audio reactive signals. Tactile affordances—such as extruded scrubbers, pill capsules, and illuminated active states—ensure immediate physical confidence under glanceable, low-light conditions. The mood evokes an executive broadcast console engineered with contemporary architectural delicacy.

## Colors

The palette is rooted in an ultra-deep obsidian environment, evoking early mornings before sunrise.
- **Obsidian Dark Foundation (`#0B0F17`, `#111827`, `#1E293B`)**: Forms the tonal foundation. Surfaces utilize controlled optical steps to build depth without bright gray washouts.
- **Sunrise Amber Primary (`#F59E0B`, accented by `#FFB800`)**: Illuminates essential actions, primary playback states, persona status indicators, and active narrative streams.
- **Electric Cyan & Violet Waveform Secondary & Tertiary (`#38BDF8`, `#818CF8`)**: Reserved for live frequency data, speech recognition feedback, audio waves, and dynamic transcription highlights.
- **High-Contrast Text System**: Strict adherence to WCAG AAA for key legibility, using `#F8FAFC` for high-emphasis headlines and `#94A3B8` for secondary metadata on dark glass layers.

## Typography

The typographic hierarchy balances structural precision with readable softness.

- **Headlines & Badges (`Space Grotesk`)**: Provides an authoritative, technical personality reminiscent of precision instrumentation and studio gear. Tight tracking gives a broadcast-grade presence.
- **Body & Captions (`Plus Jakarta Sans`)**: Delivers friendly, clear reading comfort across continuous transcripts and show notes under morning lighting conditions.
- **Scale Considerations**: High-impact titles downscale automatically on mobile viewports to prevent awkward wraps around waveform elements. A specialized large-text accessibility mode scales base body sizes upward by 20% while retaining line-height rhythm.

## Layout & Spacing

The layout utilizes a fluid 12-column responsive grid anchored by persistent audio controls and modular briefing blocks.

- **Mobile (< 768px)**: 4 columns, single-stack structure. Bottom-sheet persistent audio player sits fixed above system navigations, retaining a 1rem (`margin`) border buffer.
- **Tablet (768px - 1024px)**: 8 columns, `margin-md` (2rem). Persona selector moves to a side drawer or top horizon rail; briefs display in 2-column masonry grids.
- **Desktop (> 1024px)**: 12 columns, max-width 1360px centered with `margin-lg` (3rem). Three-pane split view: Persona & Schedule Rail (left 3 cols), Live Brief & Interactive Transcript (middle 6 cols), and Queue & Deep Dive Notes (right 3 cols).
- **Audio Control Zones**: Interactive touch targets maintain a minimum vertical clearance of `space-lg` (1.5rem) to ensure effortless, no-look thumb navigation during morning transit or preparation.

## Elevation & Depth

Visual depth is achieved through layered glass substrates, glowing highlights, and precise surface refraction rather than muddy drop shadows.

- **Ground Level (Base Canvas)**: Pure deep obsidian (`#0B0F17`) with a very subtle radial gradient of deep indigo (`#1E1B4B` at 15% opacity) centered behind the primary waveform area.
- **Level 1 (Brief Cards & Shelves)**: Background of `#111827` at 70% opacity, treated with a 16px backdrop blur, bordered by a 1px inner rim highlight (`rgba(255, 255, 255, 0.08)`).
- **Level 2 (Active Persona Modules & Floating Player)**: Background of `#1E293B` at 85% opacity, 24px backdrop blur, elevated with a diffuse sunrise underglow (`0px 8px 32px -8px rgba(245, 158, 11, 0.18)`), bordered by `rgba(245, 158, 11, 0.25)` when active.
- **Level 3 (Modals & Persona Switchers)**: High-translucency panels backed by deep slate (`#0F172A` at 92%), enclosed in an electric cyan rim glow (`rgba(56, 189, 248, 0.25)`), casting a soft ambient obsidian shadow (`0px 24px 48px -12px rgba(0, 0, 0, 0.8)`).

## Shapes

The design system incorporates rounded corners (Level 2: 0.5rem base, 1rem for standard cards, and 1.5rem for hero modules) to soften the dark-mode aesthetic. 

- Interactive buttons, scrub handles, and persona badges use rounded capsules and pill forms, offering a tactile aesthetic reminiscent of high-end hi-fi audio hardware.
- Content containers feature smooth 1rem boundaries, preventing visual hardness while maintaining space efficiency in dense narrative transcripts.

## Components

### Buttons & Transport Controls
- **Primary Play/Pause Button**: High-potency pill or circular capsule filled with Sunrise Amber (`#F59E0B`), foregrounded with rich charcoal icons (`#0B0F17`). Outer glow pulses subtly in synchronization with speech cadence.
- **Secondary Audio Controls (Skip, Persona Swap, Speed)**: Glass roundels (`#1E293B` at 60% opacity) with white rim highlights. Tactile feedback triggers an amber fill transition on press.

### Tactile Waveform Scrubber
- Consists of vertical dynamic bars tracking audio energy. 
- Played regions glow in Electric Cyan (`#38BDF8`); unplayed regions sit at `#334155`.
- Scrubber knob is an illuminated pill capsule with micro-haptic feedback indications and live timecode overlays.

### Persona Badges & Chips
- Displays current voice persona (e.g., *Protocol Droid*, *Observational Comic*, *Natural Alice & Mike*).
- Formed as frosted micro-pills containing persona glyphs, dynamic equalizers, and uppercase label typography (`label-sm`).
- Active persona is ringed with a dual gradient border (Sunrise Amber to Electric Violet).

### News Cards & Topic Blocks
- Translucent slate containers with headline text, time-to-listen indicators, category badges, and instant "Add to Daily Queue" triggers.
- Active listening card expands with an integrated visualizer and live highlighted word-by-word transcript.

### Input Fields & Search
- Recessed pill containers with dark obsidian fills (`#0B0F17`), framed by a 1px border (`#334155`). Focus transition elevates border to Electric Cyan (`#38BDF8`) with an inner 2px soft glow.

### Checkboxes, Radios & Accessibility Toggles
- High-contrast toggle switches designed with prominent visual states. Active tracks render in Sunrise Amber with crisp, white pill toggles.
- Accessibility mode toggles (Haptic Audio Feedback, Large Text, Max Contrast) remain accessible from the persistent global header.