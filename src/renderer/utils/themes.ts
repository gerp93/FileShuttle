// Flet theme IDs stored in SQLite app_settings — mapped to VisualAssault CSS classes.
export const FLET_THEME_IDS = [
  'blue_oval',
  'bubblegum',
  'commander_keen',
  'electric_lime',
  'flambeau',
  'flambeau_inverse',
  'green_acres',
  'hacker',
  'hawkeye',
  'lava',
  'merica',
  'neon',
  'red_barn',
  'retrowave',
] as const;

export type FletThemeId = (typeof FLET_THEME_IDS)[number];

export const DEFAULT_THEME_ID: FletThemeId = 'blue_oval';

const FLET_TO_CSS: Record<FletThemeId, string> = {
  blue_oval: 'blue-oval-theme',
  bubblegum: 'bubblegum-theme',
  commander_keen: 'commander-keen-theme',
  electric_lime: 'electric-lime-theme',
  flambeau: 'flambeau-theme',
  flambeau_inverse: 'flambeau-inverse-theme',
  green_acres: 'green-acres-theme',
  hacker: 'hacker-theme',
  hawkeye: 'hawkeye-theme',
  lava: 'lava-theme',
  merica: 'merica-theme',
  neon: 'neon-theme',
  red_barn: 'red-barn-theme',
  retrowave: 'retrowave-theme',
};

export const THEME_LABELS: Record<FletThemeId, string> = {
  blue_oval: 'Blue Oval',
  bubblegum: 'Bubblegum',
  commander_keen: 'Commander Keen',
  electric_lime: 'Electric Lime',
  flambeau: 'Flambeau',
  flambeau_inverse: 'Flambeau Inverse',
  green_acres: 'Green Acres',
  hacker: 'Hacker',
  hawkeye: 'Hawkeye',
  lava: 'Lava',
  merica: 'Merica',
  neon: 'Neon',
  red_barn: 'Red Barn',
  retrowave: 'Retrowave',
};

export function themeExists(themeId: string): themeId is FletThemeId {
  return FLET_THEME_IDS.includes(themeId as FletThemeId);
}

export function applyThemeFromFletId(themeId: FletThemeId | null): void {
  const cssClasses = Object.values(FLET_TO_CSS);
  cssClasses.forEach((cls) => document.body.classList.remove(cls));
  if (themeId && FLET_TO_CSS[themeId]) {
    document.body.classList.add(FLET_TO_CSS[themeId]);
  }
}

export function getThemeList(): Array<{ id: FletThemeId; label: string }> {
  return FLET_THEME_IDS.map((id) => ({ id, label: THEME_LABELS[id] }));
}
