/** Версии артефактов — п.16 client-update.txt */

export const SCHEMA_VERSION = 'client-update-schema-v1';
export const CALCULATION_RULES_VERSION = 'economy-calculator-stubs-v1';

export type IntakeContext = {
  brand?: string;
  collection?: string;
  user_comment?: string;
  target_channel_hint?: string;
  price_hint?: string;
  age_hint?: string;
  season_hint?: string;
};

export type ArtifactVersions = {
  prompt_config_version: string;
  schema_version: string;
  calculation_rules_version: string;
  model_version: string;
};
