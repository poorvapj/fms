// Dropdown order used by the "Job Card-Work Capture Form" (Google Form). New masters with these
// names get this display order; admins can change it later in Masters.

export const FORM_CATEGORY_ORDER = [
  'Civil', 'Electric', 'Plumbing', 'Security', 'Landscape', 'Wooden Work', 'Glass Work',
  'Air Conditioning', 'Painting', 'Cleaning', 'Others',
];

export const FORM_PROPERTY_ORDER = [
  'School', 'Neo Meridian', 'Nautre Park', 'NG Grande', 'Garden City', 'Milestone', 'Gulmohar City', 'Green park',
  'Orchid Green', 'Hyde Park', 'Garden Homes', 'Silver Estate', 'East Park Avenue', 'Garden Palace - Commercial',
  'Neoteric Reserve', 'Skin Clinic', 'Garden City Club', 'Mahalgaon', 'Regal Garden', 'Tekanpur', 'Badagaon Site',
  'One Business Center', 'Eden Garden',
];

/** Masters not on the form sort after it, alphabetically. */
export const DEFAULT_SORT = 999;

export function formSortOrder(table: string, name: string): number {
  const list = table === 'properties' ? FORM_PROPERTY_ORDER : table === 'work_categories' ? FORM_CATEGORY_ORDER : null;
  const i = list ? list.findIndex((n) => n.toLowerCase() === name.trim().toLowerCase()) : -1;
  return i >= 0 ? (i + 1) * 10 : DEFAULT_SORT;
}
