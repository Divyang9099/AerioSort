// Each template defines the set of sub-folders that every tower will have.
// "Select Template" in the top bar picks one of these. Add/edit freely.
export const TEMPLATES = {
  'Transmission Tower': ['Top Brs', 'Mid Brs', 'Low Brs', 'Top Spreen'],
  'Standard 4-View': ['Top', 'Mid', 'Bottom', 'Overview'],
  'Inspection (6)': ['Top', 'Upper', 'Mid', 'Lower', 'Bottom', 'Conductor'],
  'Minimal (2)': ['Top', 'Bottom'],
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES)
