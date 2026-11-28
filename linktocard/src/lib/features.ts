/**
 * Kill switches of the v3 tools and of chart images. Each is an env var that must be exactly "true"; anything else
 * (unset included) keeps the feature off, and its routes answer 503 not_configured.
 */
import { FEATURE_FLAGS, type FeatureName } from '../config';
import { ApiError } from './errors';
import type { Env } from '../types';

export function featureEnabled(env: Partial<Pick<Env, (typeof FEATURE_FLAGS)[FeatureName]>>, name: FeatureName): boolean {
  return env[FEATURE_FLAGS[name]] === 'true';
}

const NAMES: Record<FeatureName, string> = {
  batch: 'Bulk documents are',
  toolkit: 'The PDF toolkit is',
  linkcards: 'Cards from links are',
  emailfields: 'Open fields for email images are',
  charts: 'Chart images are',
  ai: 'AI images are',
};

/** 503 not_configured: what a switched-off feature answers. */
export function featureNotConfigured(name: FeatureName): ApiError {
  return new ApiError('not_configured', `${NAMES[name]} not enabled yet.`);
}

export function assertFeatureEnabled(env: Partial<Pick<Env, (typeof FEATURE_FLAGS)[FeatureName]>>, name: FeatureName): void {
  if (!featureEnabled(env, name)) throw featureNotConfigured(name);
}
