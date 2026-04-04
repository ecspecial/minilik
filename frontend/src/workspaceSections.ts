/** Hash targets for deep links from главная → кабинет (без `#`). */
export const WORKSPACE_SECTION_IDS = {
  analysis: 'module-analysis',
  constructor: 'module-constructor',
  technologist: 'module-technologist',
  purchasing: 'module-purchasing',
  finance: 'module-finance',
  marketer: 'module-marketer',
  photo: 'module-photo',
  visual: 'module-visual',
} as const;

export type WorkspaceSectionKey = keyof typeof WORKSPACE_SECTION_IDS;

export const ANCHOR_STORAGE_KEY = 'mvp_workspace_anchor';

export function hashForSection(key: WorkspaceSectionKey): string {
  return `#${WORKSPACE_SECTION_IDS[key]}`;
}
