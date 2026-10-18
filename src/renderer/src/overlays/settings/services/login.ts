// The login command a user would run themselves in a terminal, and the install command for a CLI
// that is not on this computer yet. Regatta shows these as text and never runs them.

import type { ServiceStatus } from '@shared/types'

/** Missing on purpose for shopify: no documented login command to suggest. */
export const LOGIN_COMMAND: Partial<Record<ServiceStatus['id'], string>> = {
  gh: 'gh auth login',
  glab: 'glab auth login',
  stripe: 'stripe login',
  wrangler: 'wrangler login',
  supabase: 'supabase login',
  vercel: 'vercel login'
}

/** How to install a CLI that is missing, so a not-installed row shows this instead of a login hint. */
export const INSTALL_COMMAND: Record<ServiceStatus['id'], string> = {
  gh: 'brew install gh',
  glab: 'brew install glab',
  stripe: 'brew install stripe/stripe-cli/stripe',
  wrangler: 'npm install -g wrangler',
  supabase: 'brew install supabase/tap/supabase',
  vercel: 'npm install -g vercel',
  shopify: 'npm install -g @shopify/cli'
}
