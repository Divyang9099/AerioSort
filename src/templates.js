// Built-in read-only templates. (None — every template is now user-editable.)
export const TEMPLATES = {}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES)

// Seeded once into the user's editable templates on first run, so it shows up
// under "My Templates" and can be edited or deleted like any custom template.
export const DEFAULT_CUSTOM_TEMPLATES = [
  {
    name: 'Transmission Tower',
    towerPrefix: 'T',
    zeroPad: false,
    subfolders: ['Top Insulation', 'Mid Insulation', 'Low Insulation', 'Top Spreen'],
    renameImages: false,
    imagePattern: '{tower}_{subfolder}_{original}',
  },
]
