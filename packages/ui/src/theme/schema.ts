import { z } from 'zod';

/** Semantic color token keys (camelCase → `--tm-color-kebab-case`). Order = display order. */
export const COLOR_KEYS = [
  'bg',
  'surface',
  'surfaceRaised',
  'surfaceSunken',
  'text',
  'textSecondary',
  'textMuted',
  'textEm',
  'textQuote',
  'textLink',
  'accent',
  'onAccent',
  'border',
  'borderStrong',
  'bubbleUser',
  'bubbleBot',
  'danger',
  'success',
  'warning',
  'shadow',
  'scrim',
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

const cssColor = z.string().trim().min(1);

export const ColorsSchema = z
  .object(
    Object.fromEntries(COLOR_KEYS.map((k) => [k, cssColor.optional()])) as Record<
      ColorKey,
      z.ZodOptional<typeof cssColor>
    >,
  )
  .strict();

export const FontTrack = z.enum(['serif', 'sans']);
export const Leading = z.enum(['tight', 'normal', 'relaxed']);
export const Density = z.enum(['compact', 'comfortable', 'spacious']);
/** @deprecated ST has no bubble-shape setting; kept so older tm-theme files still parse. Ignored. */
export const Bubble = z.enum(['square', 'soft', 'round']);
/** ST avatar_style: Circle 0 / Rectangle 1 (2:3 "big avatars") / Square 2 / Rounded 3 */
export const AvatarShape = z.enum(['circle', 'rectangle', 'square', 'rounded']);
/** ST chat_display: Flat 0 / Bubbles 1 / Document 2 */
export const ChatStyle = z.enum(['flat', 'bubbles', 'document']);
/** Which side the user's own messages sit on. ST is all-left; our default is messaging-app right. */
export const UserSide = z.enum(['left', 'right']);
export const Appearance = z.enum(['light', 'dark']);

export const TypographySchema = z
  .object({
    body: FontTrack.default('serif'),
    ui: FontTrack.default('sans'),
    scale: z.number().min(0.8).max(1.4).default(1),
    leading: Leading.default('relaxed'),
    serif: z.string().optional(),
    sans: z.string().optional(),
    mono: z.string().optional(),
  })
  .strict();

export const ShapeSchema = z
  .object({
    radius: z.number().min(0).max(3).default(1),
    bubble: Bubble.optional(),
    avatar: AvatarShape.default('circle'),
    borderWidth: z.number().min(0).max(4).default(1),
  })
  .strict();

export const LayoutSchema = z
  .object({
    chatMeasure: z.number().int().min(40).max(120).default(68),
    chatWidth: z.number().min(25).max(100).default(100),
    density: Density.default('comfortable'),
    chatStyle: ChatStyle.default('flat'),
    userSide: UserSide.default('right'),
    showAvatars: z.boolean().default(true),
    timestamps: z.boolean().default(true),
    /** chat page: transparent top bar over the messages with only the two icon buttons */
    immersiveChat: z.boolean().default(true),
  })
  .strict();

/** Character avatar as the chat background (app-only; ST has per-chat backgrounds instead). */
export const BackgroundSchema = z
  .object({
    avatar: z.boolean().default(false),
    opacity: z.number().min(0).max(1).default(0.25),
    blur: z.number().min(0).max(40).default(0),
    /** when replacing an avatar also keep a large copy in `backgrounds/` for this */
    keepOriginal: z.boolean().default(true),
  })
  .strict();

export const EffectsSchema = z
  .object({
    blur: z.number().min(0).max(40).default(0),
    shadow: z.number().min(0).max(1).default(0),
    reducedMotion: z.boolean().default(false),
  })
  .strict();

export const ThemeSchema = z
  .object({
    format: z.literal('tm-theme').default('tm-theme'),
    version: z.literal(1).default(1),
    name: z.string().trim().min(1),
    appearance: Appearance.default('light'),
    typography: TypographySchema.prefault({}),
    colors: ColorsSchema.prefault({}),
    shape: ShapeSchema.prefault({}),
    layout: LayoutSchema.prefault({}),
    effects: EffectsSchema.prefault({}),
    background: BackgroundSchema.prefault({}),
    customCss: z.string().default(''),
    /** ST custom_css targets ST's full DOM; imported themes keep it but start disabled. */
    customCssEnabled: z.boolean().default(true),
    /** false = "appearance only" (layout declarations stripped, DEV_NOTES §9.28); true = verbatim */
    customCssLayout: z.boolean().default(false),
    /** ST-only fields preserved verbatim for lossless export. */
    st: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type Theme = z.infer<typeof ThemeSchema>;
export type ThemeInput = z.input<typeof ThemeSchema>;

export function parseTheme(input: unknown): Theme {
  return ThemeSchema.parse(input);
}

export function safeParseTheme(input: unknown) {
  return ThemeSchema.safeParse(input);
}
