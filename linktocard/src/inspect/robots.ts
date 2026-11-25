/**
 * robots.txt, informational only: read once per check (the checked page's own site, never
 * anything else), matched the RFC 9309 way: the group for our product token if there is
 * one, else the "*" group; longest matching rule wins, Allow wins a tie; "*" and "$" in
 * paths. Each link-preview service uses its own user agent, so this says what a crawler
 * that obeys robots.txt and has no group of its own would do, not what a given platform does.
 */
import { INSPECT } from '../config';
import { type FetchDeps, FetchFailure, guardedFetch, readBody, withBudget } from './fetch';
import type { RobotsResult } from './types';

export const ROBOTS_TOKEN = 'linktocardbot';

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      // "LinkToCardBot/1.0" and "LinkToCardBot" name the same product token.
      current.agents.push(value.toLowerCase().split(/[\s/]/)[0] ?? '');
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      // An empty Disallow allows everything: it adds no rule.
      if (value !== '') current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/**
 * "*" matches any run of characters and a final "$" anchors the end; the rule matches a
 * prefix of the path otherwise. No regular expression: the checked site writes both the
 * rule and (through the URL) the path, and ".*" per "*" backtracks exponentially.
 * Matching each literal piece at its leftmost possible place is exact when "*" is the
 * only wildcard, and costs one indexOf per piece.
 */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const head = pieces[0]!;
  if (!path.startsWith(head)) return false;
  if (pieces.length === 1) return !anchored || path.length === head.length;
  let at = head.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = path.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  const last = pieces[pieces.length - 1]!;
  if (!anchored) return path.indexOf(last, at) >= 0;
  return path.length - last.length >= at && path.endsWith(last);
}

export interface RobotsDecision {
  allowed: boolean;
  /** "linktocardbot" or "*" when a group applied, null when none did. */
  agent: string | null;
  rule: Rule | null;
}

/** May a crawler with product token `token` fetch `path` (path + query)? */
export function robotsAllows(text: string, path: string, token: string = ROBOTS_TOKEN): RobotsDecision {
  const groups = parseGroups(text);
  const pick = (agent: string): Rule[] | null => {
    const matching = groups.filter((group) => group.agents.includes(agent));
    return matching.length > 0 ? matching.flatMap((group) => group.rules) : null;
  };
  const ours = pick(token);
  const agent = ours ? token : pick('*') ? '*' : null;
  const rules = ours ?? pick('*') ?? [];
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return { allowed: best ? best.allow : true, agent, rule: best };
}

export interface RobotsOptions extends FetchDeps {
  timeoutMs?: number;
}

/** Fetches {origin}/robots.txt of the page and judges its path. Never throws. */
export async function checkRobots(page: URL, options: RobotsOptions): Promise<RobotsResult> {
  const timeoutMs = options.timeoutMs ?? INSPECT.robotsTimeoutMs;
  const path = `${page.pathname}${page.search}`;
  try {
    return await withBudget(
      timeoutMs,
      async (signal) => {
        const { response } = await guardedFetch(
          new URL('/robots.txt', page).href,
          { method: 'GET', accept: 'text/plain,*/*;q=0.5', httpsOnly: true, maxRedirects: INSPECT.maxRedirects, signal },
          options,
        );
        if (response.status >= 400 && response.status < 500) {
          await response.body?.cancel().catch(() => undefined);
          return { checked: true, allowed: true, note: `robots.txt answered HTTP ${response.status}, so it sets no rules.` };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { checked: false, allowed: null, note: `robots.txt could not be read (HTTP ${response.status}).` };
        }
        const { kept } = await readBody(response, { maxBytes: INSPECT.robotsMaxBytes });
        const decision = robotsAllows(new TextDecoder().decode(kept), path);
        if (decision.allowed) return { checked: true, allowed: true, note: null };
        const who = decision.agent === '*' ? 'all crawlers (User-agent: *)' : 'LinkToCardBot';
        return {
          checked: true,
          allowed: false,
          note: `robots.txt disallows ${path} for ${who} with "Disallow: ${decision.rule?.pattern ?? ''}".`,
        };
      },
      () => new FetchFailure('timeout', `robots.txt did not load within ${timeoutMs / 1000} s.`),
    );
  } catch (error) {
    const why = error instanceof FetchFailure && error.reason !== 'blocked' ? error.message : 'It could not be fetched.';
    return { checked: false, allowed: null, note: `robots.txt could not be read: ${why}` };
  }
}
